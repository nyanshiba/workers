/**
 * files — Dufs パススループロキシ + レジューム付きチャンクアップロードゲートウェイ
 *
 * - /__up 以外はメソッド・パス・ボディをそのままオリジン (Dufs) へ中継する。
 *   一覧・ダウンロード・フォルダ ZIP・WebDAV (PROPFIND/MKCOL/MOVE 等) もここで通る。
 * - 認証は Worker 側で行う。読み取りメソッド (GET/HEAD/OPTIONS/PROPFIND) は
 *   公開。それ以外 (書き込み) は全パスで Cloudflare Access の署名済み JWT を
 *   検証して許可する。env.PROTECTED_PATHS で指定したパスは読み取りも含めて
 *   認証必須 (完全非公開)。
 * - /__up はブラウザ用アップロードページと、Cloudflare のリクエストサイズ上限を
 *   回避するための分割アップロード API。Dufs の PATCH + X-Update-Range: append
 *   を Worker 側から叩いてチャンクを追記していく。
 *
 * API:
 *   GET  /__up                     アップロードページ (HTML)
 *   POST /__up/init?path=...       現在のサーバー側オフセットを取得 {offset}
 *   PUT  /__up/chunk?path=&offset= チャンク送信 -> {offset}  (冪等: サーバー側
 *                                  サイズと突き合わせ、済みならスキップ、欠けなら 409)
 *   GET  /__up/status?path=...     {exists,size}
 *   GET  /__health                 オリジン疎通確認
 */

const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function stripHop(headers) {
  const out = new Headers();
  headers.forEach((v, k) => {
    if (!HOP_BY_HOP.has(k.toLowerCase())) out.set(k, v);
  });
  return out;
}

const BANNER =
  '<div style="background:#fff3cd;padding:8px 16px;text-align:center;font-size:14px;font-family:sans-serif;border-bottom:1px solid #f0c674;color:#000">📎 100MB を超えるファイルのアップロードは <a href="/__up" style="font-weight:bold;color:#0366d6">/__up ページ（分割送信・再開対応）</a> をご利用ください</div>';

const CACHE_CTL = "public, max-age=3600";
const NO_STORE = "no-store";

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PROPFIND"]);

/**
 * 書き込み後に Workers Cache を無効化する。
 * 対象のパスと親ディレクトリ一覧のパスを pathPrefixes で purge する
 * (cf-cache-status: HIT の古い応答が残らないようにする)。
 * ctx が無い環境 (テスト) では何もしない。
 */
async function purgePaths(ctx, urlStr) {
  if (!ctx?.cache?.purge) return;
  const u = new URL(urlStr);
  const prefixes = [u.pathname];
  const segs = u.pathname.split("/");
  if (segs[segs.length - 1] === "") segs.pop();
  segs.pop();
  prefixes.push(segs.join("/") + "/");
  try {
    await ctx.cache.purge({ pathPrefixes: prefixes });
  } catch {}
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": NO_STORE, // Workers Cache は Cache-Control なしでも既定 TTL でキャッシュする
    },
  });
}

/** オリジン (Dufs) へのリクエスト。宛先は env.ORIGIN_URL (例: http://192.168.1.10:5000) */
function originFetch(env, pathAndQuery, init) {
  const base = env.ORIGIN_URL.endsWith("/")
    ? env.ORIGIN_URL.slice(0, -1)
    : env.ORIGIN_URL;
  return env.MESH.fetch(base + pathAndQuery, init);
}

/** クライアントから渡された path (デコード済み文字列) を検証し、上流用に再エンコードする */
function sanitizePath(params) {
  const raw = params.get("path") || "";
  const decoded = decodeURIComponent(raw);
  if (!decoded || decoded.startsWith("/")) {
    return { err: "path must be relative" };
  }
  const segs = decoded.split("/").filter(Boolean);
  if (segs.length === 0) return { err: "empty path" };
  for (const s of segs) {
    if (s === "." || s === ".." || s.includes("\0")) return { err: "bad segment" };
  }
  return { upstream: segs.map(encodeURIComponent).join("/") };
}

async function originHead(env, upstreamPath) {
  const r = await originFetch(env, "/" + upstreamPath, { method: "HEAD" });
  const len = r.headers.get("content-length");
  return {
    exists: r.status < 400,
    size: len == null ? null : Number(len),
    status: r.status,
  };
}

/** オリジンへの素通しプロキシ (GET 200 は Workers Cache でキャッシュ) */
async function proxy(request, env) {
  const u = new URL(request.url);

  const init = {
    method: request.method,
    headers: stripHop(request.headers),
    redirect: "manual",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body; // ストリーム直渡し。バッファリングしない
  }
  let r;
  try {
    r = await originFetch(env, u.pathname + u.search, init);
  } catch (e) {
    return json({ error: "origin unreachable", detail: String(e) }, 502);
  }

  // GET 応答をラップ (HTML はバナー注入、200 のみ Workers Cache 対象)
  if (request.method === "GET") {
    const hdrs = stripHop(r.headers);
    hdrs.set("x-proxied-by", "files-worker");
    const isHtml = (hdrs.get("content-type") || "").includes("text/html");
    let body = r.body;
    if (isHtml) {
      hdrs.delete("content-length"); // 注入で長さが変わる
      body = (await r.text()).replace(/<body[^>]*>/i, (m) => m + BANNER);
    }
    if (r.status === 200) {
      // キャッシュ対象: ファイルプロキシに応答 Cookie は不要。Set-Cookie が
      // 残ると Workers Cache が自動 BYPASS して毎回 Worker が走るため除去する。
      hdrs.delete("set-cookie");
      // 受保護パス (/ や /private/) の GET は認証必須だが、Workers Cache は
      // 認証状態をキャッシュキーに含めない。キャッシュ HIT で 403 を
      // すり抜けるのを防ぐため、受保護パスはキャッシュ対象から外す。
      hdrs.set("cache-control", isProtectedPath(u.pathname, env) ? NO_STORE : CACHE_CTL);
    } else {
      // 404 等はヒューリスティックキャッシュ (既定 TTL) を避けるため no-store
      hdrs.set("cache-control", NO_STORE);
    }
    return new Response(body, {
      status: r.status,
      statusText: r.statusText,
      headers: hdrs,
    });
  }

  // HEAD はキャッシュを汚さない (GET/HEAD は同一キャッシュキーを共有するため、
  // 本文なし応答が格納されると後続 GET が空ボディを返す恐れがある)
  if (request.method === "HEAD") {
    const hdrs = stripHop(r.headers);
    hdrs.set("x-proxied-by", "files-worker");
    hdrs.set("cache-control", NO_STORE);
    return new Response(null, {
      status: r.status,
      statusText: r.statusText,
      headers: hdrs,
    });
  }

  // 非 GET/HEAD はストリームのまま返す
  const res = new Response(r.body, {
    status: r.status,
    statusText: r.statusText,
    headers: stripHop(r.headers),
  });
  res.headers.set("x-proxied-by", "files-worker");
  return res;
}

// ---------------------------------------------------------------------------
// 認証: Cloudflare Access が発行する RS256 JWT を Worker が自ら検証する。
// - 取得元: Cf-Access-Jwt-Assertion ヘッダー (Access 注入) / CF_Authorization Cookie
// - 検証: JWKS (TEAM_DOMAIN/cdn-cgi/access/certs) で署名 + aud (POLICY_AUD) + exp
// - 公開鍵 (JWKS) はグローバルにキャッシュする (1 時間)
// ---------------------------------------------------------------------------
let jwksCache = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

function cookieValue(request, name) {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function extractJwt(request) {
  return (
    request.headers.get("cf-access-jwt-assertion") ||
    cookieValue(request, "CF_Authorization")
  );
}

/**
 * 受保護パス判定。
 * - "/" は完全一致 (ルート直下のみ)。
 * - それ以外はプレフィックス一致。末尾スラッシュは正規化するため、
 *   "/private/" と書いても "/private" と書いても同じ扱いになる。
 *   (例: "/private/" → "/private" と "/private/配下すべて" に一致)
 */
function isProtectedPath(pathname, env) {
  const list = (env.PROTECTED_PATHS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (let p of list) {
    if (p === "/") {
      if (pathname === "/") return true;
    } else {
      p = p.replace(/\/+$/, ""); // 末尾スラッシュを正規化
      if (pathname === p || pathname.startsWith(p + "/")) return true;
    }
  }
  return false;
}

async function fetchJwks(env) {
  if (jwksCache && Date.now() - jwksCache.fetchedAt < JWKS_TTL_MS) {
    return jwksCache.keys;
  }
  const domain = env.TEAM_DOMAIN.replace(/\/+$/, "");
  const r = await fetch(`${domain}/cdn-cgi/access/certs`);
  if (!r.ok) throw new Error("jwks fetch failed: " + r.status);
  const body = await r.json();
  jwksCache = { keys: body.keys || [], fetchedAt: Date.now() };
  return jwksCache.keys;
}

function b64urlDecode(s) {
  return Uint8Array.fromBase64(s, { alphabet: "base64url" });
}

/**
 * JWT を検証する。署名 (RS256) → aud → exp の順に確認する。
 * payload は署名検証に成功した後に信用する。
 */
async function verifyJwt(jwt, env) {
  try {
    const parts = jwt.split(".");
    if (parts.length !== 3) return false;
    const [h, p, s] = parts;
    const header = JSON.parse(new TextDecoder().decode(b64urlDecode(h)));
    if (header.alg !== "RS256") return false;

    const keys = await fetchJwks(env);
    const key = keys.find((k) => k.kid === header.kid);
    if (!key) return false;

    const pub = await crypto.subtle.importKey(
      "jwk",
      key,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const data = new TextEncoder().encode(h + "." + p);
    const sig = b64urlDecode(s);
    const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", pub, sig, data);
    if (!ok) return false;

    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(env.POLICY_AUD)) return false;
    if (payload.exp && Date.now() / 1000 >= payload.exp) return false;
    return true;
  } catch {
    return false;
  }
}

async function handleUpAPI(request, env, url) {
  // POST /__up/init
  if (url.pathname === "/__up/init" && request.method === "POST") {
    const p = sanitizePath(url.searchParams);
    if (p.err) return json({ error: p.err }, 400);
    try {
      const st = await originHead(env, p.upstream);
      return json({ offset: st.exists ? st.size ?? 0 : 0 });
    } catch (e) {
      return json({ error: "origin unreachable", detail: String(e) }, 502);
    }
  }

  // GET /__up/status
  if (url.pathname === "/__up/status" && request.method === "GET") {
    const p = sanitizePath(url.searchParams);
    if (p.err) return json({ error: p.err }, 400);
    try {
      const st = await originHead(env, p.upstream);
      return json({ exists: st.exists, size: st.size ?? null });
    } catch (e) {
      return json({ error: "origin unreachable", detail: String(e) }, 502);
    }
  }

  // PUT /__up/chunk
  if (url.pathname === "/__up/chunk" && request.method === "PUT") {
    const p = sanitizePath(url.searchParams);
    if (p.err) return json({ error: p.err }, 400);
    const offset = Number(url.searchParams.get("offset"));
    if (!Number.isInteger(offset) || offset < 0) {
      return json({ error: "bad offset" }, 400);
    }
    const force = url.searchParams.get("force") === "1";
    try {
      const st = await originHead(env, p.upstream);
      const srvSize = st.exists ? st.size ?? 0 : 0;

      // 冪等性の担保: サーバー側サイズと突き合わせる
      if (!force) {
        if (srvSize > offset) {
          // このチャンク (の先頭) はすでに届いている → スキップ
          return json({ offset: srvSize, skipped: true });
        }
        if (srvSize < offset) {
          // 順番が崩れている (欠けがある)
          return json({ error: "gap", serverOffset: srvSize }, 409);
        }
      }

      // チャンクを一度読み切る (上限 CHUNK=16MiB)。長さを確定させて
      // オリジンが content-length を返さなくても正しいオフセットを返せるようにする
      const buf = await request.arrayBuffer();
      const headers = new Headers({
        "content-type": "application/octet-stream",
        "content-length": String(buf.byteLength),
      });
      let method = "PUT"; // offset===0: 新規作成/強制上書き
      if (offset > 0) {
        method = "PATCH"; // 追記
        headers.set("x-update-range", "append");
      }
      const up = await originFetch(env, "/" + p.upstream, {
        method,
        headers,
        body: buf,
      });
      if (!up.ok) {
        const t = await up.text();
        return json({ error: "origin " + up.status, detail: t.slice(0, 300) }, 502);
      }
      const after = await originHead(env, p.upstream);
      // サーバー側サイズが取れなければ送った分だけ進めた値を正とする
      return json({ offset: after.size ?? offset + buf.byteLength });
    } catch (e) {
      return json({ error: "origin unreachable", detail: String(e) }, 502);
    }
  }

  return json({ error: "not found" }, 404);
}

export default {
  async fetch(request, env, ctx) {
    // Geo 制限: JP 以外は Cloudflare のブランド付き 500 エラーページを返す。
    // /cdn-cgi/error/500 はエッジが直接配信する。Worker からの fetch は
    // 自ホストへのサブリクエスト扱いでループ保護に引っかかるため、
    // クライアントにリダイレクトさせてエッジのページを表示する。
    // request.cf?.country は本番で必ず入る。不明 IP は "XX" 等としてここで弾かれる。
    // undefined は wrangler dev 等のローカル実行時のみで、その場合は通す。
    const country = request.cf?.country;
    if (country && country !== "JP") {
      const u = new URL(request.url);
      return Response.redirect(`${u.origin}/cdn-cgi/error/500`, 302);
    }

    const url = new URL(request.url);

    if (!env.MESH || !env.ORIGIN_URL) {
      return json({ error: "MESH binding / ORIGIN_URL var is not configured" }, 500);
    }

    // 認証判定: 受保護パスは全メソッド、それ以外は書き込みメソッドが対象。
    // 読み取りメソッド (GET/HEAD/OPTIONS/PROPFIND) の公開パスはここを素通りする。
    if (isProtectedPath(url.pathname, env) || !READ_METHODS.has(request.method)) {
      if (!env.TEAM_DOMAIN || !env.POLICY_AUD) {
        // 認証が必要なのに環境変数が未設定 → フェイルクローズ (500 で明示)
        return json(
          { error: "auth env (TEAM_DOMAIN / POLICY_AUD) is not configured" },
          500
        );
      }
      const jwt = extractJwt(request);
      if (!jwt || !(await verifyJwt(jwt, env))) {
        return json({ error: "forbidden" }, 403);
      }
    }

    if (url.pathname === "/__health") {
      try {
        const st = await originHead(env, "");
        return json({ ok: st.exists, origin_status: st.status });
      } catch (e) {
        return json({ ok: false, error: String(e) }, 502);
      }
    }

    if (url.pathname === "/__up") return uploadPage();
    if (url.pathname.startsWith("/__up/")) {
      const res = await handleUpAPI(request, env, url);
      // チャンク書き込み完了 → 対象ファイル + 親ディレクトリ一覧を無効化
      if (request.method === "PUT" && url.pathname === "/__up/chunk") {
        const p = sanitizePath(url.searchParams);
        if (!p.err) {
          const u2 = new URL(request.url);
          u2.pathname = "/" + p.upstream;
          u2.search = "";
          await purgePaths(ctx, u2.href);
        }
      }
      return res;
    }

    // 読み取り系はそのままプロキシへ (Workers Cache が HIT なら Worker は実行されない)
    if (READ_METHODS.has(request.method)) return proxy(request, env);

    // 書き込み系 (PUT/PATCH/DELETE/MOVE/MKCOL 等): プロキシ後にキャッシュを無効化
    const res = await proxy(request, env);
    await purgePaths(ctx, request.url);
    return res;
  },
};

function uploadPage() {
  return new Response(UPLOAD_HTML, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const UPLOAD_HTML = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>files — upload</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:680px;margin:3rem auto;padding:0 1rem;color:#222}
  h1{font-size:1.2rem}
  #drop{border:2px dashed #aaa;border-radius:8px;padding:2.5rem;text-align:center;color:#666}
  #drop.over{border-color:#06c;color:#06c;background:#f0f7ff}
  input,button{font-size:1rem;padding:.4rem .7rem;margin-right:.5rem}
  ul#list{list-style:none;padding:0}
  li{padding:.4rem 0;border-bottom:1px solid #eee}
  .bar{background:#eee;border-radius:4px;height:8px;width:100%;margin-top:4px}
  .bar>div{background:#09c;height:8px;border-radius:4px;width:0%}
  .err{color:#c00}.ok{color:#080}.skip{color:#888}
  small{color:#777}
</style>
</head>
<body>
<h1>files — 分割アップロード</h1>
<p><small>ファイルは 16MiB ずつ順次送信されます。中断しても同じファイルを選び直せば続きから再開します。</small></p>
<p>
  <label>送信先ディレクトリ <input id="dir" placeholder="例: docs/2026"></label>
</p>
<p>
  <label><input id="force" type="checkbox"> 同名ファイルがあっても最初から送り直す</label>
</p>
<div id="drop">ドラッグ &amp; ドロップ、またはクリックして選択<input id="pick" type="file" multiple style="display:none"></div>
<ul id="list"></ul>
<script>
'use strict';
var CHUNK = 16 * 1024 * 1024; // 16 MiB
var drop = document.getElementById('drop');
var pick = document.getElementById('pick');
var dirEl = document.getElementById('dir');
var forceEl = document.getElementById('force');
var list = document.getElementById('list');

drop.addEventListener('click', function(){ pick.click(); });
drop.addEventListener('dragover', function(e){ e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', function(){ drop.classList.remove('over'); });
drop.addEventListener('drop', function(e){
  e.preventDefault(); drop.classList.remove('over');
  run(Array.from(e.dataTransfer.files));
});
pick.addEventListener('change', function(){ run(Array.from(pick.files)); pick.value=''; });

function li(file){
  var el=document.createElement('li');
  el.innerHTML='<b></b> <span class="st"></span><div class="bar"><div></div></div>';
  el.querySelector('b').textContent=file.name+' ('+file.size+' B)';
  list.appendChild(el);
  return {el:el,st:el.querySelector('.st'),bar:el.querySelector('.bar>div')};
}
function set(ui,text,cls,pct){
  ui.st.textContent=text; ui.st.className='st '+(cls||'');
  ui.bar.style.width=(pct||0)+'%';
}
function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}

async function q(url,opt){
  var r=await fetch(url,opt);
  // 認証が必要な書き込みは 403 で返る (JWT 未検証 / 未ログイン)。
  // Access が介入する場合のログイン HTML / リダイレクトも検知する。
  if(r.status===403) throw new Error('__ACCESS_EXPIRED__');
  var ct=r.headers.get('content-type')||'';
  if(r.redirected||ct.indexOf('text/html')>=0) throw new Error('__ACCESS_EXPIRED__');
  return r;
}
async function getOffset(path){
  var r=await q('/__up/init?path='+encodeURIComponent(path),{method:'POST'});
  var j=await r.json(); if(j.error)throw new Error(j.error); return j.offset||0;
}
async function sendChunk(path,offset,slice,force){
  var u='/__up/chunk?path='+encodeURIComponent(path)+'&offset='+offset+(force?'&force=1':'');
  var r=await q(u,{method:'PUT',body:slice});
  var j=await r.json().catch(function(){return{error:'bad response'};});
  if(!r.ok||j.error) throw Object.assign(new Error(j.error||('HTTP '+r.status)),{j:j});
  return j.offset;
}
async function uploadOne(file,targetDir,ui){
  var path=(targetDir?targetDir.replace(/\\\/+$/,'')+'/':'')+file.name;
  var offset=await getOffset(path);
  var forced=forceEl.checked;
  if(forced){
    offset=0; // 最初から送り直す
  }else if(file.size>0&&offset>=file.size){
    set(ui,'すでに存在します (スキップ)','ok',100);return;
  }
  set(ui,(offset>0?'再開 ':'送信中 ')+offset+'/'+file.size,'',Math.floor(offset/file.size*100));
  var fails=0;
  while(offset<file.size){
    try{
      var end=Math.min(offset+CHUNK,file.size);
      var slice=file.slice(offset,end);
      offset=await sendChunk(path,offset,slice,forced&&offset===0);
      fails=0;
      set(ui,'送信中 '+offset+'/'+file.size,'',Math.floor(offset/file.size*100));
    }catch(e){
      if(e.message==='__ACCESS_EXPIRED__'){
        set(ui,'認証が必要です。/private/ でログインしてから再試行してください','err',0);
        throw e;
      }
      if(e.j&&e.j.error==='gap'){offset=e.j.serverOffset;continue;}
      fails++;
      if(fails>5){
        set(ui,'失敗: '+e.message,'err',Math.floor(offset/file.size*100));throw e;
      }
      set(ui,'再試行中 ('+fails+'/5)','skip',Math.floor(offset/file.size*100));
      await sleep(800*fails);
      offset=await getOffset(path); // サーバー側の実サイズに合わせ直す
    }
  }
  set(ui,'完了','ok',100);
}
async function run(files){
  var targetDir=dirEl.value.trim().replace(/^\\\/+|\\\/+$/g,'');
  for(const f of files){
    var ui=li(f);
    try{await uploadOne(f,targetDir,ui);}
    catch(e){if(e.message!=='__ACCESS_EXPIRED__')console.error(e);}
  }
}
</script>
</body>
</html>`;
