---
trigger: model_decision
description: 画面・遷移仕様。ブラウザからVS Code UIに至る動線と表示条件を示す。
---

# 06 UI/UX・画面仕様

## 対象デバイス

PC ブラウザのみとする。SP・タブレット・アプリは対象外とする。

## 遷移

1. 利用者は Worker の公開 URL (`https://<worker>/?tkn=<token>`) を開く。
2. Worker は `serve-web` の HTML・静的資産を透過する。初回はサーバー取得待ちの 202 応答 (`downloading, please wait`) が出る場合があり、自動再読込で解消する。
3. `?tkn=` 検証通過後にエディタ UI が表示される。`default-folder` 指定時は当該ディレクトリが開いた状態になる。
4. ターミナル・ファイル操作・拡張機能は WebSocket 経由で動作する。Upgrade 失敗時は画面表示のみで操作が無応答になるため、F-03 の検証で切り分ける。

## 画面仕様

- VS Code 純正の Web UI をそのまま提供する。独自 CSS・独自画面は追加しない。
- `server-base-path` 未使用時はルート直下で提供する。使用時は `https://<worker>/<base>/` 配下に統一し、トークン付き URL の配布手順も同基底に合わせる。
- エラー表示は以下とする。通常画面のカスタムエラー頁は作らない。
  - 認証失敗: `serve-web` の応答をそのまま表示する。
  - Mesh 到達失敗: Worker の 503 JSON を表示する。利用者向け文面の装飾はしない。
