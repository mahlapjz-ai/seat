// AI 比对代理健康检查 - Cloudflare Pages Functions
// 路由：GET /api/health → 本文件

export async function onRequestGet() {
  return new Response(JSON.stringify({ ok: true, model: 'glm-4.6v-flash' }), {
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*'
    }
  });
}
