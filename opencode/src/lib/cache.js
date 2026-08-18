// origin の Cache-Control から正の max-age / s-maxage を取り出す(無ければ null)
const freshness = (headers) => {
  const cc = headers.get("cache-control") || "";
  for (const token of ["s-maxage", "max-age"]) {
    const m = cc.match(new RegExp(`${token}\\s*=\\s*(\\d+)`, "i"));
    if (m && Number(m[1]) > 0) return { token, seconds: Number(m[1]) };
  }
  return null;
};

// キャッシュしてよい応答か。private / no-store / Set-Cookie は絶対キャッシュしない。
export function canCache(res) {
  return (
    res.ok &&
    !res.headers.get("set-cookie") &&
    !/no-store|private/i.test(res.headers.get("cache-control") || "") &&
    freshness(res.headers) !== null
  );
}

// cacheKey をちょっとでも変えたいとき = 即 purge 用のビルダ
export function cacheKey(url, salt) {
  const sep = url.search ? "&" : "?";
  return new Request(`${url.origin}${url.pathname}${url.search}${sep}__v=${salt}`, {
    method: "GET",
  });
}
