// ============================================================
// AI 图片比对代理 - Cloudflare Worker（已弃用，保留作为备用方案）
// 当前生产环境已迁移至 Cloudflare Pages Functions（functions/api/ai-compare.js）
// 仅在需要回退到 Worker 部署时使用此文件
//
// 【v1.28.8 安全修复】同步 Pages Functions 的安全基线：
//   - S1: API Key 改为通过环境变量注入（wrangler secret put ZHIPU_API_KEY）
//   - S2: CORS 使用白名单动态校验 Origin，禁止 *
//   - S3: 基于 KV 的 IP 速率限制（需绑定 KV namespace AI_RATE_LIMIT）
//
// 部署方式：
//   1. wrangler secret put ZHIPU_API_KEY
//   2. 在 wrangler.toml 配置 KV namespace 绑定 AI_RATE_LIMIT
//   3. wrangler deploy
// ============================================================

const ZHIPU_API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const MODEL_NAME = 'glm-4.6v-flash';

// 允许的前端来源白名单
const ALLOWED_ORIGINS = new Set([
  'https://seat-def.pages.dev',
  'https://mahlapjz-ai.github.io'
]);

// 速率限制配置
const RATE_LIMIT_PER_MINUTE = 5;
const RATE_LIMIT_PER_HOUR = 30;

// 支持预览部署 URL：*.seat-def.pages.dev
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (/^https:\/\/[^/]+\.seat-def\.pages\.dev$/.test(origin)) return true;
  return false;
}

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

function getClientIp(request) {
  return request.headers.get('CF-Connecting-IP')
    || request.headers.get('X-Real-IP')
    || (request.headers.get('X-Forwarded-For') || '').split(',')[0].trim()
    || 'unknown';
}

async function checkRateLimit(env, ip) {
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
    console.warn('Rate limit check failed:', err);
    return { allowed: true, configured: true };
  }
}

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request, event.env));
});

async function handleRequest(request, env) {
  const corsHeaders = buildCorsHeaders(request);

  // 处理 CORS 预检请求
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // 白名单外 Origin 直接 403
  if (!corsHeaders['Access-Control-Allow-Origin']) {
    return new Response(JSON.stringify({ error: { message: '来源不在允许列表' } }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  const url = new URL(request.url);

  // 健康检查接口
  if (url.pathname === '/api/health') {
    return new Response(JSON.stringify({ ok: true, model: MODEL_NAME }), {
      headers: { 'Content-Type': 'application/json', ...corsHeaders }
    });
  }

  // AI 比对接口
  if (url.pathname === '/api/ai-compare' && request.method === 'POST') {
    // S1: 校验 API Key 已配置
    if (!env || !env.ZHIPU_API_KEY) {
      console.error('ZHIPU_API_KEY 环境变量未配置');
      return new Response(JSON.stringify({ error: { message: '服务未正确配置，请联系管理员' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }

    // S3: 基于 IP 的速率限制
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

          if (!zhipuResponse.ok && data.error && data.error.code === '1305') {
            lastError = data;
            lastStatus = zhipuResponse.status;
            continue;
          }

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

      return new Response(JSON.stringify(lastError || { error: { message: '所有模型均不可用' } }), {
        status: lastStatus,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    } catch (err) {
      return new Response(JSON.stringify({
        error: { message: 'Worker 内部错误: ' + err.message }
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json', ...corsHeaders }
      });
    }
  }

  return new Response('Not Found', {
    status: 404,
    headers: corsHeaders
  });
}
