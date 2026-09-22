---
trigger: model_decision
description: 用語定義。serve-web・Mesh・VPC Networksなど本件固有の語を固定する。
---

# 02 用語定義

| 用語 | 定義 |
| --- | --- |
| VS Code Server | Remote 開発のバックエンド。拡張機能・ターミナル・デバッグ等を実行する。単一ユーザー前提。 |
| `code` CLI | VS Code 同梱の CLI。`serve-web`、`tunnel` 等のサブコマンドを持つ。 |
| `serve-web` | ブラウザ向けエディタ UI を直接 HTTP 提供するサブコマンド。旧 `serve-local` の後継。`--host`、`--port` で待受を指定する。 |
| `tunnel` | `vscode.dev` 経由で到達させるサブコマンド。本件では採用しない。 |
| openvscode-server / code-server | 非純正のセルフホスト実装。本件では採用しない。 |
| Workers VPC | Worker からプライベート網へ出るための接続機能。VPC Services と VPC Networks がある。本件は VPC Networks を使う。 |
| VPC Networks | Tunnel または Mesh 全体へのバインディング。実行時に渡す URL・アドレスで宛先を決める。`fetch()` が HTTP、`connect()` がプレーン TCP を担う。 |
| Cloudflare Mesh | 旧 WARP Connector。`network_id: cf1:network` でアカウント内の Mesh 経由到達が可能になる。Gateway ポリシーが適用される。 |
| `MESH` バインディング | `wrangler.jsonc` の `vpc_networks` に定義するバインディング名。本リポジトリでは `MESH` に統一する (`grafana`、`vpc-test` と同一)。 |
| PRIVATE_BASE | 転送先起点。例 `http://10.0.7.30:8000`。ホスト名ではなくプライベート IP を指定する。 |
| connection-token | `serve-web` のクエリ・ヘッダー認証 (`?tkn=`)。`--without-connection-token` で無効化できるが本番では使わない。 |
