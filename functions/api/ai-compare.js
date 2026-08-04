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
    const body = await request.json();
    const userMessages = body.messages;

    if (!userMessages || !Array.isArray(userMessages) || userMessages.length === 0) {
      return new Response(JSON.stringify({ error: { message: 'messages 参数不能为空' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // 候选模型列表：按优先级尝试，前一个限流/失败时自动降级到下一个
    const candidateModels = body.model ? [body.model] : ['glm-4.6v-flash', 'glm-4v-flash'];

    let lastError = null;
    let lastStatus = 500;

    for (const modelName of candidateModels) {
      try {
        const zhipuResponse = await fetch(ZHIPU_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${env.ZHIPU_API_KEY}`
          },
          body: JSON.stringify({
            model: modelName,
            messages: userMessages,
            temperature: 0.1,
            max_tokens: 500
          })
        });

        const data = await zhipuResponse.json();

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
        lastError = { error: { message: '调用模型 ' + modelName + ' 失败: ' + modelErr.message } };
        lastStatus = 500;
        continue;
      }
    }

    // 所有模型都失败
    return new Response(JSON.stringify(lastError || { error: { message: '所有模型均不可用' } }), {
      status: lastStatus,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: { message: '服务内部错误: ' + err.message }
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }
}
