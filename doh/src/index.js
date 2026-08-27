// Protect & connect -> Networking -> Mesh hostname でAレコードを登録

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
    const PRIVATE_BASE = env.PRIVATE_BASE; // wrangler.jsonc の vars から注入
    const url = new URL(request.url);
    if (url.pathname !== "/dns-query") {
      // 404 応答をヒューリスティックキャッシュ(404→3min)させない
      return new Response("Not Found", {
        status: 404,
        headers: { "Cache-Control": "no-store" },
      });
    }
    if (request.method !== "GET") {
      return new Response("Method Not Allowed", {
        status: 405,
        headers: { "Cache-Control": "no-store" },
      });
    }

    const upstream = await env.MESH.fetch(
      new URL(url.pathname + url.search, PRIVATE_BASE),
      request,
    );

    if (upstream.status !== 200) {
      // エラー応答はキャッシュ対象外にする
      const headers = new Headers(upstream.headers);
      headers.set("Cache-Control", "no-store");
      return new Response(upstream.body, { status: upstream.status, headers });
    }

    // DNS 応答の最小 TTL を s-maxage に反映して Workers Cache に載せる。
    // ?dns= の base64url クエリごとに別キャッシュエントリになる。
    // TTL 0 / パース不能の応答はキャッシュしない(TTL 0 = キャッシュ禁止の意図を尊重)
    const body = await upstream.arrayBuffer();
    const headers = new Headers(upstream.headers);
    const ttl = parseMinTtl(new Uint8Array(body));
    if (ttl && ttl > 0) {
      headers.set("Cache-Control", `public, s-maxage=${ttl}`);
    } else {
      headers.set("Cache-Control", "no-store");
    }

    return new Response(body, { status: upstream.status, headers });
  },
};
