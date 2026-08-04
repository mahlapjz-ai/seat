// ============================================================
// AI 图片比对代理 - Cloudflare Pages Functions
// 功能：转发前端请求到智谱 GLM-4.6V-Flash，隐藏 API Key
// 路由：POST /api/ai-compare → 本文件
// 部署：Pages 项目会自动识别 functions/ 目录，无需额外配置
// ============================================================

const ZHIPU_API_URL = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';
const MODEL_NAME = 'glm-4.6v-flash';

// CORS 头（同源调用其实不需要，保留以兼容旧前端直连场景）
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};

// 处理 OPTIONS 预检请求
export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

// 处理 POST 比对请求
export async function onRequestPost(context) {
  const { request, env } = context;

  // 【v1.28.3】优先使用环境变量中的 API Key，fallback 到内置值（防止忘记配置环境变量）
  const ZHIPU_API_KEY = env.ZHIPU_API_KEY || '144dcae7ee9741c7ab35514e5c53a83d.so1Cjg6ei4PnepcC';

  try {
    const body = await request.json();
    const userMessages = body.messages;

    if (!userMessages || !Array.isArray(userMessages) || userMessages.length === 0) {
      return new Response(JSON.stringify({ error: { message: 'messages 参数不能为空' } }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
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
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
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
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  } catch (err) {
    return new Response(JSON.stringify({
      error: { message: '服务内部错误: ' + err.message }
    }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
  }
}
