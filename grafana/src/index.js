const PRIVATE_BASE = "http://10.64.7.30:3000";
const CACHE_SALT = "v5"; // 反映させたいときに increment = 即 purge

// origin の Cache-Control から正の max-age / s-maxage を取り出す(無ければ null)
function getPositiveFreshness(headers) {
  const cc = headers.get("cache-control") || "";
  for (const token of ["s-maxage", "max-age"]) {
    const m = cc.match(new RegExp(`${token}\\s*=\\s*(\\d+)`, "i"));
    if (m && Number(m[1]) > 0) return { token, seconds: Number(m[1]) };
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cacheKey = new Request(`${url}?__v=${CACHE_SALT}`, { method: "GET" });

    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;

    const origin = await env.MESH.fetch(
      new URL(url.pathname + url.search, PRIVATE_BASE),
      request,
    );
    if (origin.status !== 200) return new Response(origin.body, origin);

    // 正の max-age/s-maxage がある応答だけキャッシュ。無い応答は透過(=誤 HIT 回避)
    if (getPositiveFreshness(origin.headers)) {
      ctx.waitUntil(caches.default.put(cacheKey, origin.clone()).catch(() => {}));
    }
    return origin;
  },
};
