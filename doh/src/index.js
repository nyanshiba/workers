// Protect & connect -> Networking -> Mesh hostname でAレコードを登録
const PRIVATE_BASE = "https://dot.nyanshiba.com:443";
const DNS_DEFAULT_TTL_SECONDS = 120; // TTL が読めない場合のフォールバック

// DNS 名をスキップして、その次のフィールド(TYPE)の先頭 offset を返す
function nameEnd(buf, off) {
  let guard = 0;
  while (true) {
    if (guard++ > 100) return -1;
    const len = buf[off];
    if (len === 0) return off + 1;          // 終端 0x00 → その次
    if ((len & 0xc0) === 0xc0) return off + 2; // 圧縮ポインタ(0b11xxxxxx)→ ポインタ2バイトの次
    off += 1 + len;
  }
}

// DNS 応答から Answer+Authority+Additional の最小 TTL を返す(無ければ null)
function parseMinTtl(buf) {
  const qdcount = (buf[4] << 8) | buf[5];
  const ancount = (buf[6] << 8) | buf[7];
  const nscount = (buf[8] << 8) | buf[9];
  const arcount = (buf[10] << 8) | buf[11];

  let off = 12;
  for (let i = 0; i < qdcount; i++) {
    const e = nameEnd(buf, off);
    if (e < 0) return null;
    off = e + 4; // QTYPE(2) + QCLASS(2)
  }

  let min = Infinity;
  const total = ancount + nscount + arcount;
  for (let i = 0; i < total; i++) {
    const e = nameEnd(buf, off);
    if (e < 0) break;
    const ttl =
      (buf[e + 4] << 24) | (buf[e + 5] << 16) | (buf[e + 6] << 8) | buf[e + 7];
    const rdlength = (buf[e + 8] << 8) | buf[e + 9];
    if (ttl > 0) min = Math.min(min, ttl);
    off = e + 10 + rdlength; // TYPE(2)+CLASS(2)+TTL(4)+RDLEN(2)+RDATA
  }
  return min === Infinity ? null : min;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/dns-query") return new Response("Not Found", { status: 404 });
    if (request.method !== "GET") return new Response("Method Not Allowed", { status: 405 });

    const cacheKey = new Request(url.toString(), { method: "GET" }); // ?dns= 込みクエリがそのままキー
    const cached = await caches.default.match(cacheKey);
    if (cached) return cached;

    const upstream = await env.MESH.fetch(
      new URL(url.pathname + url.search, PRIVATE_BASE),
      request,
    );

    if (upstream.status !== 200) return new Response(upstream.body, upstream);

    const body = await upstream.arrayBuffer();
    const headers = new Headers(upstream.headers);
    const ttl = parseMinTtl(new Uint8Array(body));
    const sMaxAge = ttl && ttl > 0 ? ttl : DNS_DEFAULT_TTL_SECONDS;
    headers.set("Cache-Control", `public, s-maxage=${sMaxAge}`);

    const toCache = new Response(body, { status: upstream.status, headers });
    await caches.default.put(cacheKey, toCache.clone());
    return toCache;
  },
};
