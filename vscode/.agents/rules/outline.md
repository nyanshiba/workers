# 概要

個人開発用のリモート VS Code を Workers VPC 経由で使う。`vscode.dev` を介さず、プライベート VM の `serve-web` に直接転送する。

## 結論

- 引用コメントの `serve-local` は現行 `code serve-web` に相当し、`--host 0.0.0.0` で全インターフェイス待受が可能である。ソース (`args.rs`、`serve_web.rs`) で確認済みである。
- 起動は `code serve-web --host 0.0.0.0 --port 8000 --connection-token-file ... --accept-server-license-terms --disable-telemetry` とする。
- Worker は `grafana/` の Mesh 転送とキャッシュ判定を流用する。`PRIVATE_BASE` を VS Code ホストに向け、`Set-Cookie` を保持し、`Upgrade: websocket` 分岐を追加する。無修正流用は不可である。

## 構成

`Browser → Worker (公開) → env.MESH.fetch() → serve-web:8000 (0.0.0.0)`。`vpc_networks` は `binding MESH`、`network_id cf1:network`、`remote true` とする。DB は持たない。

## 制約

- 単一ユーザー・PC ブラウザのみ。サービス化・複数人提供はしない。
- 恒久運用で `--without-connection-token` を禁止する。トークンはファイル (`0600`) 管理とする。
- 受け入れは VM 内 `curl`、Worker 経由 UI 表示、ターミナル・保存動作、トークンなし拒否で行う。WebSocket 不調時は Gateway ログと VPC Metrics で切り分ける。
