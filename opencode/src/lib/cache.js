// Workers Caching(エントリポイントキャッシュ)用の宣言的ヘッダ制御。
// Workers Caching は Worker が返す Cache-Control だけを見てキャッシュ可否を決める
// (wrangler.jsonc の "cache": { "enabled": true } が前提)。
// ヒューリスティックキャッシュ(RFC 9111、200->2h)を避けるため、
// キャッシュしない応答には必ず明示的に no-store を付ける。

// シェル(HTML)の TTL。アプリ更新後も最大この時間は旧シェルがエッジに残る。
export const SHELL_MAX_AGE = 300;

export function cacheHeaders(headers, pathname, status) {
  const out = new Headers(headers);

  // 非 2xx(404 や 500 の HTML 等)はキャッシュしない。
  if (status !== undefined && (status < 200 || status >= 300)) {
    out.set("cache-control", "no-store");
    return out;
  }

  const type = out.get("content-type") ?? "";
  const isShell = type.includes("text/html");
  const isAsset = pathname.startsWith("/assets/");

  if (isShell) {
    // CSS パッチ済みシェル: 明示的に public,max-age を付けて Workers Caching に載せる。
    out.delete("set-cookie"); // Set-Cookie があると自動 BYPASS になるため除去
    out.set("cache-control", `public, max-age=${SHELL_MAX_AGE}`);
  } else if (isAsset) {
    // ハッシュ付き不変アセット: origin の Cache-Control を尊重する(無ければヒューリスティック)。
    out.delete("set-cookie");
  } else {
    // 動的応答(SSE・履歴・API JSON)はキャッシュしない。
    out.set("cache-control", "no-store");
  }
  return out;
}