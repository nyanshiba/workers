const PRIVATE_BASE = "http://10.64.7.8:8476";
const CACHE_TTL_SECONDS = 604800;
const CACHE_SALT = "v4"; // 反映させたいときに increment = 即 purge

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

    const body = await origin.arrayBuffer();
    const headers = new Headers(origin.headers);
    headers.set("Cache-Control", `public, max-age=${CACHE_TTL_SECONDS}, stale-if-error=${CACHE_TTL_SECONDS}`);
    const res = new Response(body, { status: origin.status, headers });
    ctx.waitUntil(caches.default.put(cacheKey, res.clone()).catch(() => {}));
    return res;
  },
};
