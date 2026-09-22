# 静的キャッシュ仕様差分案

`vscode/src/index.js:65` の一律 `no-store` を条件付き透過に変えるための差分案である。実装前の合意用であり、合意後に `spec-docs/03,04,05,07` へ反映する。

## 根拠

- VS Code 本体: `src/vs/server/node/webClientServer.ts` の `serveFile()` は `NO_CACHING=no-store`、`ETAG=弱ETag+304`、`NO_EXPIRY=public, max-age=31536000` を使い分ける。`_handleStatic()` (`/static/*`) はビルド品で `NO_EXPIRY` になる。`_handleRoot()` (`/`) と `_handleCallback()` は `Cache-Control` を付けない。`cli/src/commands/serve_web.rs` は `Cache-Control` を触らず `Set-Cookie` と `CSP` のみ付加する。よって Worker が見る上流値は内側サーバの値である。
- 実測 (VM 内直叩き): `/` は `200 text/html` で `Cache-Control` なし、`Set-Cookie` あり。`/stable-<commit>/static/out/vs/code/browser/workbench/workbench.js` と `.css` は `cache-control: public, max-age=31536000` で `Set-Cookie` 2 件 (秘密鍵系) と `CSP frame-ancestors` 付きだった。
- 実測 (`eth0` で `tcp port 8000 and net 100.64.0.0/12` を採取、37k パケット): Mesh 経由の応答側にも同一の小文字 `cache-control: public, max-age=31536000` (JS/CSS/画像等) を確認した。大文字 `Cache-Control: no-cache` は再読込時のブラウザ要求側である。版接頭辞 `/stable-<commit>/static/` 付きのためキーは版付きになる。

## 方針

- `grafana` と同一構成にする。`wrangler.jsonc` に `cache: { enabled: true }` (Workers Caching) を追加し、コードはヘッダ制御のみで CDN キャッシュを駆動する。`caches.default` の明示操作はしない。
- 判定も `grafana/src/index.js:20-39` と同一にする。GET 200 かつ上流が正の `max-age/s-maxage` を持つ場合のみ透過し、それ以外は `no-store` に落とす。パス制限は付けない。上流 `/` HTML は `Cache-Control` なし (実測済み) のため freshness 判定で落ちる。
- `no-store` 落としは外せない。Workers Caching では `Cache-Control` なし応答も RFC 9111 ヒューリスティックで既定 TTL キャッシュされるため、単純継承にすると動的 HTML (nonce・`remoteAuthority`・週次トークン Cookie 入り) が誤 HIT する。`grafana` の else 節 (`35-39`) がそのためのものである。
- 透過時は `Set-Cookie` を削除する (`grafana:28` と同一、BYPASS 防止)。実測で静的応答にも秘密鍵系 `Set-Cookie` 2 件が付くため、残すと HIT しない。

## 対象判定

`grafana` と同一の3条件のみとする。以下をすべて満たす場合のみ上流ヘッダを透過し (`Set-Cookie` 削除、`public` 補完は `grafana:27-32` と同一)、それ以外は `no-store` に上書きする。

- `request.method` が `GET` である。
- 上流 `status` が `200` である。
- 上流 `Cache-Control` から正の `s-maxage`/`maxage` が取れる (判定は `grafana` の `getPositiveFreshness` を流用する)。

WebSocket (`Upgrade` あり、`101`) は従来通り先行分岐で返し、本判定に入れない。`?tkn=` の除去・Cookie 付与 (`vscode/src/index.js:17,23-30`) と HTML の origin 書換え (`79-124`) は変えない。

## spec-docs 差分

### wrangler.jsonc

`grafana/wrangler.jsonc:8-10` と同一のブロックを追加する。

```jsonc
"cache": {
  "enabled": true
},
```

### 03-architecture.md (流用差分)

現行:

- キャッシュ判定を撤去し、一律 `no-store` とする。VS Code の応答は動的であり、誤 HIT が許容できない。

変更後:

- `grafana` の条件判定を持ち込む。GET 200 かつ上流が正の `max-age/s-maxage` を持つ場合のみ透過し (`Set-Cookie` 削除、`public` 補完を含む)、それ以外は一律 `no-store` とする。動的応答 (`/`、`callback`、API、WebSocket) は上流に freshness がないため従来通り対象外になる。

### 04-functional.md (F-02)

現行:

- 応答は `status`・`headers`・`body` をそのまま返す。`Cache-Control` は `no-store` に上書きする。`Set-Cookie` は保持する。

変更後:

- 応答は `status`・`headers`・`body` をそのまま返す。`Cache-Control` は以下とする。
  - 透過条件 (GET・上流200・上流に正の `max-age/s-maxage`) を満たす場合、`Set-Cookie` を削除し (`grafana` の BYPASS 防止と同一)、`public` 補完の上で上流値を維持する。
  - それ以外は `no-store` に上書きする (`Set-Cookie` は保持する)。

### 05-datamodel.md (要求対応)

現行:

| `GET /<path>?<query>` (通常 HTTP) | `env.MESH.fetch(PRIVATE_BASE + path + query, request)` の応答を `no-store` で返却 |

変更後:

| `GET /<path>?<query>` (透過条件を満たす) | `env.MESH.fetch(...)` の応答の `Cache-Control` を透過 (`Set-Cookie` 削除、`public` 補完)。CDN キャッシュ (`cf-cache-status: HIT`) の対象になる |
| 上記以外の通常 HTTP | `env.MESH.fetch(...)` の応答を `no-store` で返却 (従来通り。ヒューリスティックキャッシュによる誤 HIT 防止) |

状態保持の行に以下を追記する。ブラウザ保持に加え Workers Caching (CDN) を利用する。`Cache-Tag` や purge 運用は設けない。

### 07-nonfunctional.md (性能・制約)

現行:

- Worker は透過転送のみとし、変換・圧縮・結合を行わない。
- エッジキャッシュは無効 (`no-store`) とする。`grafana` の積極 cache 方式は持ち込まない。

変更後:

- Worker は透過転送のみとし、変換・圧縮・結合を行わない。
- `wrangler.jsonc` で Workers Caching (`cache.enabled`) を有効にし、CDN キャッシュを最大化する。`no-store` 落としは残す。`Cache-Control` なし応答もヒューリスティックでキャッシュされるため、外すと動的 HTML が誤 HIT する。

## 受け入れ

- VM 内直叩きで `/static/` 系が `public, max-age=31536000` である (済み)。
- Worker 経由 `curl -D` で `/stable-<commit>/static/...js` の `Cache-Control` が透過され、`/` が `no-store` のままである。
- 静的の応答ヘッダに `cf-cache-status: HIT` が出る (2 回目以降)。`/` には出ない。
- ブラウザ再読込で静的が `disk/memory cache` から出て、ターミナル・保存 (WebSocket) が従来通り動く。
- トークンなし要求の拒否挙動が変わらない。
