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
  async fetch(request, env) {
    const PRIVATE_BASE = env.PRIVATE_BASE; // wrangler.jsonc の vars から注入
    const url = new URL(request.url);
    const origin = await env.MESH.fetch(
      new URL(url.pathname + url.search, PRIVATE_BASE),
      request,
    );

    // GET 200 かつ origin が正の max-age/s-maxage を持つ応答だけキャッシュする。
    // max-age の値は origin のものを尊重し、そのまま cf-cache-status に反映させる。
    if (
      request.method === "GET" &&
      origin.status === 200 &&
      getPositiveFreshness(origin.headers)
    ) {
      const headers = new Headers(origin.headers);
      headers.delete("set-cookie"); // BYPASS 防止
      // private だとエッジキャッシュ不可になるため public を補完する(値は origin のまま)
      const cc = headers.get("cache-control") || "";
      if (!/public/i.test(cc)) headers.set("Cache-Control", `public, ${cc}`);
      return new Response(origin.body, { status: origin.status, headers });
    }

    // それ以外はキャッシュ対象外にする
    // (正の max-age の無い応答をヒューリスティックにキャッシュして誤 HIT するのを防ぐ)
    const headers = new Headers(origin.headers);
    headers.set("Cache-Control", "no-store");
    return new Response(origin.body, { status: origin.status, headers });
  },
};
