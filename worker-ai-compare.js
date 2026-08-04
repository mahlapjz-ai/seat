// ============================================================
// AI 图片比对代理 - Cloudflare Worker
// 功能：转发前端请求到智谱 GLM-4.6V-Flash，隐藏 API Key
// 部署：复制此文件内容到 Cloudflare Workers
// ============================================================

// 智谱 API Key（已内置，前端无需暴露）
const ZHIPU_API_KEY = '144dcae7ee9741c7ab35514e5c53a83d.so1Cjg6ei4PnepcC';
const ZHIPU_API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const MODEL_NAME = 'glm-4.6v-flash';

// 允许的前端来源（防止滥用），* 表示允许所有，可改为你的域名
const ALLOW_ORIGIN = '*';

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  // 处理 CORS 预检请求
  if (request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': ALLOW_ORIGIN,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400'
      }
    });
  }

  const url = new URL(request.url);

  // 健康检查接口
  if (url.pathname === '/api/health') {
    return new Response(JSON.stringify({ ok: true, model: MODEL_NAME }), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': ALLOW_ORIGIN
      }
    });
  }

  // AI 比对接口
  if (url.pathname === '/api/ai-compare' && request.method === 'POST') {
    try {
      const body = await request.json();
      const userMessages = body.messages;

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
              'Authorization': `Bearer ${ZHIPU_API_KEY}`
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
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': ALLOW_ORIGIN
            }
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
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': ALLOW_ORIGIN
        }
      });
    } catch (err) {
      return new Response(JSON.stringify({
        error: { message: 'Worker 内部错误: ' + err.message }
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': ALLOW_ORIGIN
        }
      });
    }
  }

  return new Response('Not Found', {
    status: 404,
    headers: { 'Access-Control-Allow-Origin': ALLOW_ORIGIN }
  });
}
