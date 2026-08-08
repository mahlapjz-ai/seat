// ============================================================
// 大图压缩 Worker（v1.30.0 新增）
// 作用：将上传图片的 Canvas 绘制 + JPEG 编码移出主线程，
//       消除选图后返回主页面的 1-2 秒卡顿。
// 调用方：主线程 compressImage()（scripts.js）
// 策略：
//   1. createImageBitmap 异步解码图片（Worker 内支持，不阻塞主线程）
//   2. OffscreenCanvas 按原图尺寸绘制
//   3. convertToBlob 完成 JPEG 编码（OffscreenCanvas 不支持 toDataURL）
//   4. 转 ArrayBuffer 后 transfer 回主线程，主线程再 FileReader 转 Base64
// 兼容：OffscreenCanvas / createImageBitmap 不可用时，
//       Worker 上报失败，主线程自动回退到同步 Canvas 压缩。
// ============================================================

self.onmessage = async (e) => {
  const { id, imageData, quality } = e.data || {};
  try {
    // 环境检测：旧浏览器 Worker 内无 OffscreenCanvas
    if (typeof OffscreenCanvas === 'undefined') {
      self.postMessage({ id, ok: false, error: 'OffscreenCanvas unavailable' });
      return;
    }
    // imageData 为 ArrayBuffer（主线程已将 data URL 转 Blob 再转 ArrayBuffer）
    let bitmap;
    if (imageData instanceof ArrayBuffer) {
      bitmap = await createImageBitmap(imageData);
    } else if (typeof imageData === 'string') {
      // 兼容直接传入 data URL / blob URL
      const resp = await fetch(imageData);
      const blob = await resp.blob();
      bitmap = await createImageBitmap(blob);
    } else {
      self.postMessage({ id, ok: false, error: 'unsupported imageData type' });
      return;
    }

    const w = bitmap.width, h = bitmap.height;
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0);
    // 释放位图内存
    try { bitmap.close(); } catch (e2) {}

    const outBlob = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality });
    const buf = await outBlob.arrayBuffer();
    // transfer ArrayBuffer，避免拷贝
    self.postMessage({ id, ok: true, buffer: buf }, [buf]);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
