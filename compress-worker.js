// ============================================================
// 大图压缩 Worker（v1.30.0 新增 / v1.30.1 修复 bitmap 泄漏与超大图保护）
// 作用：将上传图片的 Canvas 绘制 + JPEG 编码移出主线程，
//       消除选图后返回主页面的 1-2 秒卡顿。
// 调用方：主线程 compressImage()（scripts.js）
// 策略：
//   1. createImageBitmap 异步解码图片（Worker 内支持，不阻塞主线程）
//   2. OffscreenCanvas 绘制（最大边长 4096，超大图等比缩放，防 OOM）
//   3. convertToBlob 完成 JPEG 编码（OffscreenCanvas 不支持 toDataURL）
//   4. 转 ArrayBuffer 后 transfer 回主线程，主线程再 FileReader 转 Base64
// 兼容：OffscreenCanvas / createImageBitmap 不可用时，
//       Worker 上报失败，主线程自动回退到同步 Canvas 压缩。
// ============================================================

// 最大边长限制：超过则等比缩放，防止超大图 OOM（4096×4096 RGBA ≈ 67MB，可接受）
const MAX_SIDE = 4096;

self.onmessage = async (e) => {
  const { id, imageData, quality } = e.data || {};
  let bitmap = null;
  try {
    // 环境检测：旧浏览器 Worker 内无 OffscreenCanvas
    if (typeof OffscreenCanvas === 'undefined') {
      self.postMessage({ id, ok: false, error: 'OffscreenCanvas unavailable' });
      return;
    }
    // imageData 为 ArrayBuffer（主线程已将 data URL 转 Blob 再转 ArrayBuffer）
    if (imageData instanceof ArrayBuffer) {
      // 用 Blob 包装提升旧浏览器兼容性（部分实现只接受 Blob）
      bitmap = await createImageBitmap(new Blob([imageData]));
    } else if (typeof imageData === 'string') {
      // 兼容直接传入 data URL / blob URL
      const resp = await fetch(imageData);
      const blob = await resp.blob();
      bitmap = await createImageBitmap(blob);
    } else {
      self.postMessage({ id, ok: false, error: 'unsupported imageData type' });
      return;
    }

    // 超大图等比缩放，防 OOM
    let dw = bitmap.width, dh = bitmap.height;
    const maxSide = Math.max(dw, dh);
    if (maxSide > MAX_SIDE) {
      const scale = MAX_SIDE / maxSide;
      dw = Math.round(dw * scale);
      dh = Math.round(dh * scale);
    }

    const canvas = new OffscreenCanvas(dw, dh);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, dw, dh);

    // 质量参数兜底
    const q = (typeof quality === 'number' && quality > 0 && quality <= 1) ? quality : 0.92;
    const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: q });
    const buf = await outBlob.arrayBuffer();
    // transfer ArrayBuffer，避免拷贝
    self.postMessage({ id, ok: true, buffer: buf }, [buf]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  } finally {
    // 【v1.30.1】无论成功或异常都释放位图内存，防止泄漏
    if (bitmap) { try { bitmap.close(); } catch (e2) {} }
  }
};
