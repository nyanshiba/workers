import { filterEventStream, isKept } from "./lib/sse.js";
import { applyHistoryFilter, HISTORY_PATH } from "./lib/history.js";
import { applyUiTweaks } from "./lib/ui.js";
import { cacheHeaders } from "./lib/cache.js";

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
    const target = new URL(url.pathname + url.search, env.PRIVATE_BASE);

    const headers = new Headers(request.headers);
    const auth = authHeader(env);
    if (auth) headers.set("authorization", auth);

    const init = { method: request.method, headers };
    if (request.method !== "GET" && request.method !== "HEAD" && request.body) {
      init.body = request.body;
    }

    let response = await env.MESH.fetch(target, init);
    // /event は SPA HTML のため対象外
    if (url.pathname === "/api/event" && response.body) {
      const out = new Headers(response.headers);
      out.delete("content-length"); // フィルタで長さが変わる
      response = new Response(response.body.pipeThrough(filterEventStream(isKept)), {
        status: response.status,
        headers: out,
      });
    } else if (HISTORY_PATH.test(url.pathname)) {
      response = await applyHistoryFilter(response);
    }

    // text/html の GET 応答にだけ CSS パッチを当てる。
    if (request.method === "GET") response = await applyUiTweaks(response);

    const out = cacheHeaders(response.headers, request.method, response.status);
    return new Response(response.body, { status: response.status, headers: out });
  },
};
