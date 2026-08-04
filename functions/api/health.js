// AI 比对代理健康检查 - Cloudflare Pages Functions
// 路由：GET /api/health → 本文件
// 【v1.28.8】CORS 改为白名单动态校验，移除 *

const ALLOWED_ORIGINS = new Set([
  'https://seat-def.pages.dev',
  'https://mahlapjz-ai.github.io'
]);

// 支持预览部署 URL：*.seat-def.pages.dev
function isAllowedOrigin(origin) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  if (/^https:\/\/[^/]+\.seat-def\.pages\.dev$/.test(origin)) return true;
  return false;
}

function buildCorsHeaders(request) {
  const origin = request.headers.get('Origin');
  const headers = { 'Content-Type': 'application/json', 'Vary': 'Origin' };
  if (isAllowedOrigin(origin)) {
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
