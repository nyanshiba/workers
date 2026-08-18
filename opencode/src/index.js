const PRIVATE_BASE = "http://10.64.10.40:49374";
const CACHE_SALT = "v5"; // 反映させたいときに increment = 即 purge

import { filterEventStream, isKept } from "./lib/sse.js";
import { canCache, cacheKey } from "./lib/cache.js";

const toOrigin = (u) => new URL(u.pathname + u.search, PRIVATE_BASE);

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. SSE: reasoning を落として中継(キャッシュしない)
    if (url.pathname === "/event" || url.pathname.endsWith("/event")) {
      const origin = await env.MESH.fetch(toOrigin(url), request);
      const headers = new Headers(origin.headers);
      headers.delete("content-length"); // フィルタで長さが変わる
      return new Response(
        origin.body?.pipeThrough(filterEventStream(isKept)) ?? null,
        { status: origin.status, headers },
      );
    }

    // 2. 非 GET は透過
    if (request.method !== "GET") return env.MESH.fetch(toOrigin(url), request);

    // 3. GET は正の max-age がある応答だけキャッシュ
    const key = cacheKey(url, CACHE_SALT);
    const cached = await caches.default.match(key);
    if (cached) return cached;

    const origin = await env.MESH.fetch(toOrigin(url), request);
    if (canCache(origin)) {
      ctx.waitUntil(caches.default.put(key, origin.clone()).catch(() => {}));
    }
    return origin;
  },
};
