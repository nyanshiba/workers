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

// ヘッダを差し替えた新しい Response を作る(ボディは引き継ぐ)。
// Workers Caching は Worker が返す Cache-Control でキャッシュ可否を決めるため、
// 中継する応答には必ずキャッシュ方針ヘッダを付けてから返す。
function repackage(response, headers) {
  return new Response(response.body, { status: response.status, headers });
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

    // 1. SSE: reasoning / tool.input.delta を落として中継(動的 -> no-store)
    //    /event は SPA HTML なので /api/event のみ対象にする。
    if (url.pathname === "/api/event") {
      const origin = await env.MESH.fetch(target, init);
      const out = cacheHeaders(origin.headers, url.pathname, origin.status);
      out.delete("content-length"); // フィルタで長さが変わる
      return new Response(
        origin.body?.pipeThrough(filterEventStream(isKept)) ?? null,
        { status: origin.status, headers: out },
      );
    }

    // 2. 履歴: assistant の reasoning パートを落として JSON を返す(動的 -> no-store)
    if (HISTORY_PATH.test(url.pathname)) {
      const origin = await env.MESH.fetch(target, init);
      const filtered = await applyHistoryFilter(origin);
      const out = cacheHeaders(filtered.headers, url.pathname, filtered.status);
      out.delete("content-length");
      return repackage(filtered, out);
    }

    // 3. HEAD: GET とキャッシュキーを共有するため、本文なし応答の混入を防ぐ目的で no-store
    if (request.method === "HEAD") {
      const origin = await env.MESH.fetch(target, init);
      const out = new Headers(origin.headers);
      out.set("cache-control", "no-store");
      return repackage(origin, out);
    }

    // 4. 非 GET は透過(Workers Caching は GET/HEAD のみ対象)
    if (request.method !== "GET") return env.MESH.fetch(target, init);

    // 5. GET: 静的 UI(HTML シェル・/assets)だけ Workers Caching に載せる。
    //    シェルは CSS パッチ注入後の応答に public,max-age を宣言、動的 API は
    //    no-store にしてヒューリスティックキャッシュ(200->2h)を防ぐ。
    const origin = await env.MESH.fetch(target, init);
    const response = await applyUiTweaks(origin); // text/html のみ CSS パッチ
    return repackage(
      response,
      cacheHeaders(response.headers, url.pathname, response.status),
    );
  },
};
