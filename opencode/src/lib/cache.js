// 正の max-age / s-maxage を取り出す(無ければ null)。
function getPositiveFreshness(headers) {
  const cc = headers.get("cache-control") || "";
  for (const token of ["s-maxage", "max-age"]) {
    const m = cc.match(new RegExp(`${token}\\s*=\\s*(\\d+)`, "i"));
    if (m && Number(m[1]) > 0) return { token, seconds: Number(m[1]) };
  }
  return null;
}

// GET 200 + 正の freshness だけ載せ、それ以外は no-store。
export function cacheHeaders(headers, method, status) {
  const out = new Headers(headers);

  if (
    method === "GET" &&
    status >= 200 &&
    status < 300 &&
    getPositiveFreshness(out)
  ) {
    out.delete("set-cookie"); // Set-Cookie 付きは自動 BYPASS される
    const cc = out.get("cache-control") || "";
    if (!/public/i.test(cc)) out.set("Cache-Control", `public, ${cc}`); // private はエッジに載らない
    return out;
  }

  // 載せない応答はヒューリスティックキャッシュ防止のため明示する
  out.set("cache-control", "no-store");
  return out;
}
