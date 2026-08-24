import { filterEventStream, isKept } from "./lib/sse.js";
import { canCache, cacheKey } from "./lib/cache.js";
import { applyHistoryFilter, HISTORY_PATH } from "./lib/history.js";
import { applyUiTweaks } from "./lib/ui.js";

// 認証が env で与えられた場合のみ Basic ヘッダを付与(未設定なら素通し)。
function authHeader(env) {
  const username = env.OPCODE_AUTH_USERNAME;
  const password = env.OPCODE_AUTH_PASSWORD;
  if (!username || !password) return undefined;
  return "Basic " + btoa(`${username}:${password}`);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const base = env.PRIVATE_BASE;
    const target = new URL(url.pathname + url.search, base);

    const headers = new Headers(request.headers);
    const auth = authHeader(env);
    if (auth) headers.set("authorization", auth);

    const init = { method: request.method, headers };
    if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
      init.body = request.body;
    }

    // 1. SSE: reasoning / tool.input.delta を落として中継(キャッシュしない)
    if (url.pathname === "/event" || url.pathname.endsWith("/event")) {
      const origin = await env.MESH.fetch(target, init);
      const headersOut = new Headers(origin.headers);
      headersOut.delete("content-length"); // フィルタで長さが変わる
      return new Response(
        origin.body?.pipeThrough(filterEventStream(isKept)) ?? null,
        { status: origin.status, headers: headersOut },
      );
    }

    // 2. 履歴: assistant の reasoning パートを落として JSON を返す
    if (HISTORY_PATH.test(url.pathname)) {
      const origin = await env.MESH.fetch(target, init);
      return applyHistoryFilter(origin);
    }

    // 3. 非 GET は透過
    if (request.method !== "GET") return env.MESH.fetch(target, init);

    // 4. GET は正の max-age がある応答だけキャッシュ
    const key = cacheKey(url, env.CACHE_SALT);
    const cached = await caches.default.match(key);
    if (cached) return cached;

    // text/html には Web UI 用 CSS パッチを注入(メッセージヘッダーの常時表示)
    const response = await applyUiTweaks(await env.MESH.fetch(target, init));
    if (canCache(response)) {
      ctx.waitUntil(caches.default.put(key, response.clone()).catch(() => {}));
    }
    return response;
  },
};
