const CACHE_TTL_SECONDS = 604800;

export default {
  async fetch(request, env) {
    const PRIVATE_BASE = env.PRIVATE_BASE; // wrangler.jsonc の vars から注入
    const url = new URL(request.url);
    const origin = await env.MESH.fetch(
      new URL(url.pathname + url.search, PRIVATE_BASE),
      request,
    );

    // GET 200 だけ 7 日間キャッシュする(Workers Cache は Cache-Control 駆動)
    if (request.method === "GET" && origin.status === 200) {
      const headers = new Headers(origin.headers);
      headers.delete("set-cookie"); // BYPASS 防止(静的サイトに応答 Cookie は不要)
      headers.set(
        "Cache-Control",
        `public, max-age=${CACHE_TTL_SECONDS}, stale-if-error=${CACHE_TTL_SECONDS}`,
      );
      return new Response(origin.body, { status: origin.status, headers });
    }

    // 非 GET / 非 200 はキャッシュ対象外にする
    // (ヒューリスティックキャッシュ 200→2h / 404→3min による誤 HIT を防ぐ)
    const headers = new Headers(origin.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(origin.body, { status: origin.status, headers });
  },
};
