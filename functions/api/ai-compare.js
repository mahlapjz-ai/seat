// ============================================================
// AI 图片比对代理 - Cloudflare Pages Functions
// 功能：转发前端请求到智谱 GLM-4.6V-Flash，隐藏 API Key
// 路由：POST /api/ai-compare → 本文件
// 部署：Pages 项目会自动识别 functions/ 目录，无需额外配置
//
// 【v1.28.8 安全修复】
//   - S1: 移除硬编码 API Key，改为 env.ZHIPU_API_KEY 注入，未配置时直接 500
//   - S2: CORS 使用白名单动态校验 Origin，禁止 *
//   - S3: 基于 KV 的 IP 速率限制（每分钟 5 次 / 每小时 30 次）
//
// 部署前置：
//   1. 在 Cloudflare Pages 项目设置环境变量 ZHIPU_API_KEY
//   2. 创建 KV namespace 并绑定为 AI_RATE_LIMIT（未绑定时放行，但无防护）
// ============================================================

const ZHIPU_API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

// 允许的前端来源白名单（仅这两个域名的页面可调用）
const ALLOWED_ORIGINS = new Set([
  'https://seat-def.pages.dev',
  'https://mahlapjz-ai.github.io'
]);

// 速率限制配置
const RATE_LIMIT_PER_MINUTE = 5;
const RATE_LIMIT_PER_HOUR = 30;

// 【v1.28.9 H4/M7/M8 安全加固】请求体与内容限制
const MAX_BODY_BYTES = 2 * 1024 * 1024;        // H4: 请求体上限 2MB（2 张压缩到 1024px 的 base64 图约 200-400KB，2MB 足够）
const MAX_MESSAGES_LENGTH = 20;                 // M7: messages 数组上限
const MAX_MESSAGE_CONTENT_CHARS = 3 * 1024 * 1024; // M7: 单条 message content 上限 3MB
const ALLOWED_MODELS = ['glm-4.6v-flash', 'glm-4v-flash']; // M8: 模型白名单
const UPSTREAM_TIMEOUT_MS = 20000;               // M6: 上游 fetch 超时 20 秒（前端 30 秒，留 10 秒余量）

// 判断 Origin 是否在白名单内
//   - 精确匹配：seat-def.pages.dev / mahlapjz-ai.github.io
//   - 通配匹配：*.seat-def.pages.dev（Cloudflare Pages 预览部署 URL，如 307823c4.seat-def.pages.dev）
//     说明：seat-def.pages.dev 子域名全局唯一，仅项目 owner 可创建预览部署，安全可控
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (/^https:\/\/[^/]+\.seat-def\.pages\.dev$/.test(origin)) return true;
  return false;
}

// 根据请求 Origin 构建 CORS 头（动态回显白名单内 Origin）
function buildCorsHeaders(request) {
  const origin = request.headers.get('Origin');
  const headers = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if (isAllowedOrigin(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

// 获取客户端真实 IP（Cloudflare 注入）
function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Real-IP')
    || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
    || 'unknown';
}

// 基于 KV 的 IP 速率限制
async function checkRateLimit(env, ip) {
  // KV 未绑定时放行（避免配置缺失导致功能不可用，但失去限流防护）
  if (!env.AI_RATE_LIMIT) return { allowed: true, configured: false };
  if (ip === 'unknown') return { allowed: true, configured: true };

  const now = Date.now();
  const minuteKey = `rl:m:${ip}:${Math.floor(now / 60000)}`;
  const hourKey = `rl:h:${ip}:${Math.floor(now / 3600000)}`;

  try {
    const [minuteCount, hourCount] = await Promise.all([
      env.AI_RATE_LIMIT.get(minuteKey),
      env.AI_RATE_LIMIT.get(hourKey)
    ]);

    if (parseInt(minuteCount || '0', 10) >= RATE_LIMIT_PER_MINUTE) {
      return { allowed: false, retryAfter: 60, reason: 'minute', configured: true };
    }
    if (parseInt(hourCount || '0', 10) >= RATE_LIMIT_PER_HOUR) {
      return { allowed: false, retryAfter: 3600, reason: 'hour', configured: true };
    }

    await Promise.all([
      env.AI_RATE_LIMIT.put(minuteKey, String(parseInt(minuteCount || '0', 10) + 1), { expirationTtl: 120 }),
      env.AI_RATE_LIMIT.put(hourKey, String(parseInt(hourCount || '0', 10) + 1), { expirationTtl: 3600 })
    ]);

    return { allowed: true, configured: true };
  } catch (err) {
    // KV 异常时放行，避免影响主流程（记录日志便于排查）
    console.warn('Rate limit check failed:', err);
    return { allowed: true, configured: true };
  }
}

// 处理 OPTIONS 预检请求
export async function onRequestOptions(context) {
  const { request } = context;
  return new Response(null, {
    status: 204,
    headers: buildCorsHeaders(request)
  });
}

// 处理 POST 比对请求
export async function onRequestPost(context) {
  const { request, env } = context;
  const corsHeaders = buildCorsHeaders(request);

  // 1. S2: CORS 拒绝 —— 白名单外的 Origin 直接 403
  if (!corsHeaders['Access-Control-Allow-Origin']) {
    return new Response(JSON.stringify({ error: { message: '来源不在允许列表' } }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  // 2. S1: 校验 API Key 已配置（未配置时不暴露内部信息）
  if (!env.ZHIPU_API_KEY) {
    console.error('ZHIPU_API_KEY 环境变量未配置');
    return new Response(JSON.stringify({ error: { message: '服务未正确配置，请联系管理员' } }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  // 3. S3: 基于 IP 的速率限制
  const clientIp = getClientIp(request);
  const rateLimit = await checkRateLimit(env, clientIp);
  if (!rateLimit.allowed) {
    const tip = rateLimit.reason === 'minute'
      ? '请求过于频繁，请稍后再试'
      : '本小时调用次数已达上限，请稍后再试';
    return new Response(JSON.stringify({ error: { message: tip } }), {
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'Retry-After': String(rateLimit.retryAfter),
        ...corsHeaders
      }
    });
  }

  try {
    // 【v1.28.9 H4修复】请求体大小限制：先检查 Content-Length，再限制读取字节数
    //   防止攻击者发送超大 body 耗尽 Worker CPU 配额
    const contentLength = parseInt(request.headers.get('Content-Length') || '0', 10);
    if (contentLength > MAX_BODY_BYTES) {
      return new Response(JSON.stringify({ error: { message: '请求体过大' } }), {
        status: 413,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // 限制实际读取字节数（双保险，防止 Content-Length 伪造）
    const rawBody = await request.text();
    if (rawBody.length > MAX_BODY_BYTES) {
      return new Response(JSON.stringify({ error: { message: '请求体过大' } }), {
        status: 413,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    let body;
    try {
      body = JSON.parse(rawBody);
    } catch (e) {
      return new Response(JSON.stringify({ error: { message: '请求格式错误' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    const userMessages = body.messages;

    if (!userMessages || !Array.isArray(userMessages) || userMessages.length === 0) {
      return new Response(JSON.stringify({ error: { message: 'messages 参数不能为空' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // 【v1.28.9 M7修复】messages 内容深度校验
    //   - 数组长度上限，防止超长数组消耗上游配额
    //   - 单条 message 的 role/content 字段类型校验
    //   - content 字段长度上限，防止超大 base64 图片
    // 【v1.28.11 修复】content 支持 string 和 array 两种类型
    //   原校验写死 typeof content === 'string'，但智谱 GLM-4V 多模态格式要求 content 为数组：
    //     content: [{ type:'text', text:'...' }, { type:'image_url', image_url:{ url:'...' } }]
    //   原校验会拒绝合法多模态请求，导致 AI 比对 100% 失败。改为支持两种类型并分别校验结构。
    if (userMessages.length > MAX_MESSAGES_LENGTH) {
      return new Response(JSON.stringify({ error: { message: 'messages 数组过长' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
    for (let i = 0; i < userMessages.length; i++) {
      const msg = userMessages[i];
      if (!msg || typeof msg !== 'object') {
        return new Response(JSON.stringify({ error: { message: `messages[${i}] 格式错误` } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      if (typeof msg.role !== 'string') {
        return new Response(JSON.stringify({ error: { message: `messages[${i}] role 字段类型错误` } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      // content 可为 string（纯文本）或 array（多模态，智谱 GLM-4V 格式）
      if (typeof msg.content !== 'string' && !Array.isArray(msg.content)) {
        return new Response(JSON.stringify({ error: { message: `messages[${i}] content 字段类型错误` } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      // 字符串型 content：直接校验长度
      if (typeof msg.content === 'string') {
        if (msg.content.length > MAX_MESSAGE_CONTENT_CHARS) {
          return new Response(JSON.stringify({ error: { message: `messages[${i}] 内容过大` } }), {
            status: 413,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        continue;
      }
      // 数组型 content（多模态）：逐项校验结构，防止注入非法字段
      if (msg.content.length > MAX_MESSAGES_LENGTH) {
        return new Response(JSON.stringify({ error: { message: `messages[${i}] content 数组过长` } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      for (let j = 0; j < msg.content.length; j++) {
        const part = msg.content[j];
        if (!part || typeof part !== 'object') {
          return new Response(JSON.stringify({ error: { message: `messages[${i}].content[${j}] 格式错误` } }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        if (typeof part.type !== 'string') {
          return new Response(JSON.stringify({ error: { message: `messages[${i}].content[${j}] 缺少 type 字段` } }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
        if (part.type === 'text') {
          if (typeof part.text !== 'string') {
            return new Response(JSON.stringify({ error: { message: `messages[${i}].content[${j}] text 字段类型错误` } }), {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
          if (part.text.length > MAX_MESSAGE_CONTENT_CHARS) {
            return new Response(JSON.stringify({ error: { message: `messages[${i}].content[${j}] 文本过大` } }), {
              status: 413,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
        } else if (part.type === 'image_url') {
          if (!part.image_url || typeof part.image_url.url !== 'string') {
            return new Response(JSON.stringify({ error: { message: `messages[${i}].content[${j}] image_url 格式错误` } }), {
              status: 400,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
          if (part.image_url.url.length > MAX_MESSAGE_CONTENT_CHARS) {
            return new Response(JSON.stringify({ error: { message: `messages[${i}].content[${j}] 图片数据过大` } }), {
              status: 413,
              headers: { 'Content-Type': 'application/json', ...corsHeaders }
            });
          }
        } else {
          // 未知 type，拒绝以防注入（仅允许 text / image_url）
          return new Response(JSON.stringify({ error: { message: `messages[${i}].content[${j}] 不支持的 type` } }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }
      }
    }

    // 【v1.28.9 M8修复】模型白名单校验
    //   原实现允许 body.model 传任意值，攻击者可传收费模型（如 glm-4.6v）产生费用
    //   现仅允许白名单内的免费模型，不在白名单的 model 字段忽略并走默认降级
    let candidateModels;
    if (body.model) {
      if (!ALLOWED_MODELS.includes(body.model)) {
        return new Response(JSON.stringify({ error: { message: '不支持的模型' } }), {
          status: 400,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      }
      candidateModels = [body.model];
    } else {
      candidateModels = ['glm-4.6v-flash', 'glm-4v-flash'];
    }

    let lastError = null;
    let lastStatus = 500;

    for (const modelName of candidateModels) {
      try {
        // 【v1.28.9 M6修复】上游 fetch 加超时控制
        //   原实现无超时，上游卡住时 Worker 会一直等待，占用并发槽位
        //   用 AbortController 实现，超时后中止请求
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

        let zhipuResponse;
        try {
          zhipuResponse = await fetch(ZHIPU_API_URL, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${env.ZHIPU_API_KEY}`
            },
            body: JSON.stringify({
              model: modelName,
              messages: userMessages,
              temperature: 0.1,
              // 【v1.28.8】提升到 1024：GLM-4.6V 是推理模型，reasoning_content 也消耗 tokens
              //   原 500 太小，思考过程未结束 tokens 就用光，导致实际 JSON 被截断解析失败
              //   注意：glm-4.6v-flash 上限为 1024，超出会报 1210 错误
              max_tokens: 1024
            }),
            signal: controller.signal
          });
        } finally {
          clearTimeout(timeoutId);
        }

        // 【v1.28.9 修复】上游返回非 JSON 时容错处理（如 502 HTML 错误页）
        const respText = await zhipuResponse.text();
        let data;
        try {
          data = JSON.parse(respText);
        } catch (e) {
          // 上游返回非 JSON（可能是 502/504 网关错误页），构造结构化错误
          return new Response(JSON.stringify({
            error: { message: '上游服务暂时不可用，请稍后重试', upstream_status: zhipuResponse.status }
          }), {
            status: 502,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
          });
        }

        // 如果返回 1305 限流错误，尝试下一个模型
        if (!zhipuResponse.ok && data.error && data.error.code === '1305') {
          lastError = data;
          lastStatus = zhipuResponse.status;
          continue;
        }

        // 成功或其他错误直接返回（其他错误不降级，避免掩盖真正问题）
        return new Response(JSON.stringify(data), {
          status: zhipuResponse.status,
          headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
      } catch (modelErr) {
        // 【v1.28.9 M6】区分超时错误，给出更友好的提示
        if (modelErr.name === 'AbortError') {
          lastError = { error: { message: '上游响应超时，请稍后重试' } };
          lastStatus = 504;
        } else {
          // 【v1.28.9 修复】不再透传 err.message，避免泄露内部细节
          console.error('调用模型 ' + modelName + ' 失败:', modelErr);
          lastError = { error: { message: '调用模型 ' + modelName + ' 失败' } };
          lastStatus = 500;
        }
        continue;
      }
    }

    // 所有模型都失败
    return new Response(JSON.stringify(lastError || { error: { message: '所有模型均不可用' } }), {
      status: lastStatus,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (err) {
    // 【v1.28.9 修复】不再透传 err.message，仅记录日志，返回通用错误
    console.error('AI比对服务内部错误:', err);
    return new Response(JSON.stringify({
      error: { message: '服务内部错误，请稍后重试' }
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}
