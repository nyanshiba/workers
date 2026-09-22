---
trigger: model_decision
description: 背景・目的・結論。serve-localが現行serve-webであること、0.0.0.0 listen可であることの根拠を示す。
---

# 01 はじめに

## 背景

プライベート網内の開発用マシンで動作する VS Code Server に対し、ブラウザのみでアクセスしたい。`vscode.dev` のトンネル経由ではなく、Workers VPC 経由でプライベート IP に直接到達する方式が求められた。

引用されたコメント (microsoft/vscode#135856, comment 1191310842) は 2022 年時点のもので、`serve-local` モードへの言及がある。当該コメントは以下を主張する。

- 低速回線やインターネット非接続の閉域網では `vscode.dev` が選択肢にならない。
- 自己ホストの `vscode.dev` 相当として `serve-local` が要件を満たす。
- 詳細は当時の `vscode-server` ドキュメントの self-host 項目を参照せよ。

## 目的

本仕様書は以下を確定させる。

- `serve-local` が現行機能として利用可能か。
- `0.0.0.0` で listen できるか。
- Workers VPC (VPC Networks + Cloudflare Mesh) 経由で個人開発用途の VS Code Web UI を提供する実装方法。

サービス名は個人開発用のリモート VS Code とする。単一ユーザーの利用を前提とし、複数人同時利用やサービス化は対象外とする。

## 結論

可能である。ただしコマンド名は変更されている。

- 旧 `serve-local` は現行の `code serve-web` に相当する。
- `code serve-web --host 0.0.0.0 --port 8000` で全インターフェイス待受が可能である。
- 根拠はソースコードである。`cli/src/commands/args.rs` の `ServeWebArgs` は `host: Option<String>` (未指定時は localhost)、`port: u16` (既定 8000) を定義する。`cli/src/commands/serve_web.rs` の `serve_web()` は `host` をパースして `TcpListener::bind(addr)` する。`None` の場合のみ `127.0.0.1` にフォールバックする。したがって `0.0.0.0` の明示指定で全インターフェイス待受になる。
- プライベート網側は `0.0.0.0:8000` で `serve-web` を起動し、Worker 側は `env.MESH.fetch()` で `http://<private-ip>:8000` に転送する。`grafana/src/index.js` の転送パターンが流用可能である。ただし WebSocket 分岐の追加が必要であり、無修正での流用は不可である。
