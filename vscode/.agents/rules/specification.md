# 個人開発用のリモート VS Code 仕様書

Workers VPC + Mesh 経由でプライベート網の `serve-web` に接続する個人開発用途の仕様である。`vscode.dev` トンネルは使わない。

## 構成

- [01 はじめに](spec-docs/01-intro.md): 背景・目的・結論 (`serve-local` は現行 `serve-web`)。
- [02 用語定義](spec-docs/02-terms.md): 語彙の固定。
- [03 システム概要](spec-docs/03-architecture.md): 構成図・技術スタック・`grafana` 流用差分。
- [04 機能要件詳細](spec-docs/04-functional.md): 起動・HTTP 転送・WebSocket 転送・認証・診断。
- [05 データモデル](spec-docs/05-datamodel.md): DB なし。構成値と要求対応。
- [06 UI/UX・画面仕様](spec-docs/06-uiux.md): PC ブラウザ動線。
- [07 非機能要件](spec-docs/07-nonfunctional.md): ライセンス・セキュリティ・性能・運用。

## 適用範囲

- 単一ユーザー・PC ブラウザのみ。複数人提供は対象外。
- Worker は JavaScript、`wrangler.jsonc` の `MESH` バインディング (`cf1:network`) を使う。
- `grafana/` 転送・キャッシュ判定を雛形とし、WebSocket 分岐を追加する。
