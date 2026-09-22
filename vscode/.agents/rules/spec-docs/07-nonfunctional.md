---
trigger: model_decision
description: 非機能要件。ライセンス・セキュリティ・性能・運用の制約を示す。
---

# 07 非機能要件

## ライセンス・倫理

- VS Code Server は単一ユーザー利用を前提とする。複数人同時利用・サービスとしての提供は行わない。本件は個人開発用途であり条件を満たす。
- 初回起動のライセンス同意を `--accept-server-license-terms` で記録する。同意なしの運用はしない。
- スクレイピング・自動化回避・個人情報の収集等の要素はない。利用規約違反・法的リスク・倫理的問題は検出されない。
- 懸念点はトークン漏えいのみである。URL 配布は本人限定とし、漏えい時はトークンファイルを再生成する。

## セキュリティ

- 恒久運用で `--without-connection-token` を禁止する。Mesh 到達後は閉域でもトークン検証を残す。
- トークンファイルは `0600` とする。起動ログの `?tkn=` 行は保管・共有しない。
- `Set-Cookie` を保持するため、Worker のキャッシュ・改変でセッションを壊さない。
- Gateway ポリシーで Mesh 経路の拒否が起きた場合は `http_request_denied` として検出する。Gateway Logs > Network で拒否イベントを確認する。
- cloudflared 経路を使う場合、QUIC 接続と 2025.7.0 以降の版を前提とする。`TUNNEL_TRANSPORT_PROTOCOL=http2` では VPC の DNS 解決が失敗しうる。

## 性能・制約

- Worker は透過転送のみとし、変換・圧縮・結合を行わない。
- Workers Caching (`wrangler.jsonc` の `cache.enabled`) を有効にし、CDN キャッシュを使う。透過条件を満たす静的のみ保持し、それ以外は `no-store` とする。`Cache-Control` なし応答もヒューリスティックでキャッシュされるため、`no-store` 落としは残す。
- WebSocket 長時間接続は Workers の課金・継続条件に従う。切断時の再接続はブラウザ再読込で回復する。
- `serve-web` の無接続時アイドル停止 (既定 60 分) を前提とする。常駐が必要な場合は systemd の `Restart` で復帰させる。

## 運用・観測

- 監視は以下とする。専用ダッシュボードは新設しない。
  - Worker の `console.error` (Mesh 失敗時の `name`・`message`)。
  - VPC Service Metrics のエラー分類 (Bad Upstream / Client / Internal)。
  - `serve-web` の標準出力 (`Server bound to`、`stdout`/`stderr` 行)。
- 変更時は `PRIVATE_BASE`・`--port`・トークンの三点を同時に確認する。
- 受け入れ条件は以下である。
  - VM 内 `curl` が 200 を返す。
  - Worker 経由の静的 UI 表示ができる。
  - ターミナル入力・ファイル保存ができる。
  - トークンなし要求が拒否される。
