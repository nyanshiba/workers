---
trigger: model_decision
description: データ・配線モデル。DBなしのため構成値と要求対応関係を定義する。
---

# 05 データモデル

本件に RDB・ER 図は存在しない。代わりに構成値と要求対応を固定する。

## 構成値

| 項目 | 保管場所 | 例 |
| --- | --- | --- |
| `PRIVATE_BASE` | `wrangler.jsonc` の `vars` | `http://10.0.1.50:8000` |
| `vpc_networks` | `wrangler.jsonc` | `[{ binding: MESH, network_id: cf1:network, remote: true }]` |
| connection-token | VS Code ホストのファイル (`0600`) | `/etc/vscode/serve-web-token` |
| 待受 | `serve-web` 引数 | `--host 0.0.0.0 --port 8000` |

## 要求対応

| 入力 | 出力 |
| --- | --- |
| `GET /<path>?<query>` (透過条件を満たす: 上流 200 かつ正の freshness) | `env.MESH.fetch(PRIVATE_BASE + path + query, request)` の応答の `Cache-Control` を透過 (`Set-Cookie` 削除)。CDN キャッシュの対象になる |
| 上記以外の通常 HTTP | `env.MESH.fetch(PRIVATE_BASE + path + query, request)` の応答を `no-store` で返却 |
| `GET /<path>` + `Upgrade: websocket` | 同一宛先へ WebSocket として転送し、101 + `webSocket` で応答 |
| Mesh 到達失敗 | 503 + `{ error, reason, hint }` |

## 状態保持

- Worker は状態を持たない。セッション・トークン・秘密鍵は `serve-web` 側とブラウザ Cookie が保持する。
- 透過条件を満たす静的のみ Workers Caching に保持する。動的応答は `no-store` のため保持されない。
