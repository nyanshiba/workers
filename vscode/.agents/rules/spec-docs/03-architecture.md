---
trigger: model_decision
description: システム概要。全体構成・技術スタック・grafanaからの流用差分を把握するために読む。
---

# 03 システム概要

## アーキテクチャ

ブラウザが Worker (公開 URL) にアクセスし、Worker が VPC Networks + Mesh 経由でプライベート VM の `serve-web` に転送する。`vscode.dev` や Microsoft のトンネル網は経由しない。

```
Browser --(HTTPS/WSS, 公開)--> Worker --(HTTP/WS over Mesh, fetch)--> serve-web:8000 (0.0.0.0)
```

既存資産との関係は以下である。

- `grafana/` の Worker を雛形とする。`wrangler.jsonc` の `vpc_networks` 定義はそのまま流用する。
- `vpc-test/` の `/probe` 相当の疎通確認手順を流用する。L7 (`fetch`) と L4 (`connect`) の切り分けができる。
- VS Code 側ホストはプライベート網内の単一 VM とする。OS は systemd 利用可能な Linux を想定する。

## 技術スタック

| 層 | 選定 |
| --- | --- |
| Worker | JavaScript。`grafana/src/index.js` と同一形式。Hono 等の導入はしない。 |
| 設定 | `wrangler.jsonc`。`vpc_networks: [{ binding: MESH, network_id: cf1:network, remote: true }]`。 |
| VS Code 側 | `code serve-web --host 0.0.0.0 --port 8000`。systemd 常駐は任意。 |
| 認証 | `connection-token` 必須。`--without-connection-token` は検証時の一時利用に限定する。 |
| 転送 | `env.MESH.fetch()` を主経路とする。`connect()` は診断・代替に限定する。 |

## grafana からの流用差分

`grafana/src/index.js` は以下を行う。

- `env.PRIVATE_BASE` へ `pathname + search` を付けて `env.MESH.fetch(url, request)` で転送する。
- GET 200 かつ origin が正の `max-age`/`s-maxage` を持つ場合のみエッジキャッシュし、それ以外は `no-store` にする。

VS Code 用では以下を変更する。

- `PRIVATE_BASE` を VS Code ホストに向ける。例 `http://10.0.x.y:8000`。
- `grafana` のキャッシュ判定を持ち込む。GET 200 かつ上流が正の `max-age`/`s-maxage` を持つ場合のみ透過し (`Set-Cookie` 削除、`public` 補完を含む)、それ以外は一律 `no-store` とする。動的応答は上流に freshness がないため対象外になる。
- `wrangler.jsonc` に `cache.enabled: true` (Workers Caching) を追加し、CDN キャッシュを有効にする。
- `Upgrade: websocket` 検出分岐を追加する。`grafana` にはこの分岐がなく、このままではターミナル・拡張機能ホスト等の WebSocket が動作しない。
- `Set-Cookie` を削除しない。VS Code の秘密鍵 mint とセッション維持に Cookie が必要である。`grafana` の `set-cookie` 削除処理は持ち込まない。
- `server-base-path` 使用時はパス付加規則を合わせる。未使用時は単純結合でよい。
