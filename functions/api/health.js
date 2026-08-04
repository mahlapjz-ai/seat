// AI 比对代理健康检查 - Cloudflare Pages Functions
// 路由：GET /api/health → 本文件
// 【v1.28.8】CORS 改为白名单动态校验，移除 *

const ALLOWED_ORIGINS = new Set([
  'https://seat-def.pages.dev',
  'https://mahlapjz-ai.github.io'
]);

function buildCorsHeaders(request) {
  const origin = request.headers.get('Origin');
  const headers = { 'Content-Type': 'application/json', 'Vary': 'Origin' };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}

export async function onRequestGet(context) {
  const { request } = context;
  return new Response(JSON.stringify({ ok: true, model: 'glm-4.6v-flash' }), {
    headers: buildCorsHeaders(request)
  });
}
