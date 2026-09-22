---
trigger: model_decision
description: 機能要件詳細。serve-web起動・Worker転送・認証・検証の実装条件を示す。
---

# 04 機能要件詳細

## F-01 serve-web を 0.0.0.0 で起動する

起動コマンドは以下とする。

```
code serve-web --host 0.0.0.0 --port 8000 --connection-token-file /etc/vscode/serve-web-token --accept-server-license-terms --disable-telemetry
```

要件は以下である。

- `--host 0.0.0.0` を必須とする。未指定時は localhost 待受になるため Mesh 経由で到達できない。
- `--port` は既定 8000 とする。変更時は `PRIVATE_BASE` と同時に変更する。
- 初回起動時にライセンス条項へ同意する。`--accept-server-license-terms` を付与する。
- `--disable-telemetry` を付与する。 telemetry 水準を変える場合は別途指定する。
- トークンは `--connection-token-file` で与える。ファイル権限は `0600` とする。CLI が `serve-web-token` を自動生成する動作に依存しない。
- `--default-folder` は任意とする。指定時は起動直後の既定ディレクトリになる。
- `--server-base-path` は既定で未使用とする。使用時は Worker のパス結合と `?tkn=` 付与の双方で考慮する。
- 起動ログに `Web UI available at http://0.0.0.0:8000?tkn=...` が出ることを確認する。`?tkn=` の値は秘匿し、ログに残さない運用とする。

systemd 常駐を使う場合、`ExecStart` に上記コマンドを指定し、`Restart=on-failure` とする。サービス化禁止は VS Code Server 自体の提供形態に関する条件であり、単一利用者の常駐化は本件の範囲内とする。複数人への提供目的での常駐化は行わない。

## F-02 Worker が HTTP を転送する

転送規則は以下である。

- `PRIVATE_BASE` は `wrangler.jsonc` の `vars` で注入する。値は `http://<private-ip>:8000` とする。ホスト名ではなく IP を使う。
- 受信した `pathname + search` を `PRIVATE_BASE` 基準で結合し、`env.MESH.fetch(target, request)` で転送する。`request` をそのまま渡すことでメソッド・ヘッダー・ボディを維持する。
- `Host` は上書きしない。Workers の `fetch` は `Host` を禁止ヘッダとして無視し、MESH宛URLのホストが送られる。転送時は `X-Forwarded-Host` に公開ホスト名、`X-Forwarded-Proto` に公開スキームを入れる。serve-web は `X-Forwarded-Host` を `remoteAuthority` と `resourceUrlTemplate` に反映するため、私的アドレスのままではブラウザが私的宛に接続しにいき壊れる。`Host` 単独の上書きは cookie 不一致で 403 になるため使わない。HTML 応答内の origin は公開 origin に書換える (`http→https`、`ws→wss`、bareホスト、`Location`・`CSP` を含む)。
- 応答は `status`・`headers`・`body` をそのまま返す。`Cache-Control` は以下とする。透過条件 (GET・上流 200・上流に正の `max-age`/`s-maxage`) を満たす場合は `Set-Cookie` を削除して上流値を維持し、それ以外は `no-store` に上書きする (`Set-Cookie` は保持する)。
- `?tkn=` は除去・記録しない。認証情報として透過させる。

## F-03 Worker が WebSocket を転送する

VS Code Web UI は通常 HTTP に加え WebSocket を使う。Worker は以下を実装する。

- 受信リクエストの `Upgrade` ヘッダーが `websocket` (大小無視) の場合に WebSocket 経路へ分岐する。
- `env.MESH.fetch(target, request)` に `Upgrade: websocket` 付きで転送し、101 応答の `webSocket` をクライアントへ返す。Workers の標準的な WebSocket プロキシ手順 (`fetch` + `webSocket` 応答 + `accept({ allowHalfOpen: true })`) に従う。
- 上記で接続できない場合の診断として、`env.MESH.connect(host:port)` による TCP 到達確認を残す。`vpc-test` の `/probe?mode=connect` と同等である。
- `connect()` はプレーン TCP のみである。`serve-web` は既定で HTTP のため条件を満たす。TLS 終端を `serve-web` 側に追加しない。

検証順序は以下である。

1. `curl` で `http://<private-ip>:8000/` に VM 内から到達することを確認する。
2. Worker の `/probe?mode=fetch` で Mesh 経由 HTTP 到達を確認する。
3. ブラウザで Worker URL を開き、静的 UI が表示されることを確認する。
4. ターミナル・ファイル保存等の WebSocket 依存操作を確認する。失敗時は Gateway の Logs > Network と VPC Service Metrics を突き合わせる。

## F-04 認証を透過させる

- `--without-connection-token` は恒久運用で使わない。検証時の一時利用後は必ずトークンありに戻す。
- トークンは URL の `?tkn=` または Cookie で送られる。Worker は正規化・剥離しない。
- 追加の認証層 (Access 等) を設ける場合は Worker の前段に置き、Mesh 転送の前で完結させる。`serve-web` 側の設定は変えない。
- トークンファイルの再生成時は Worker 側の変更は不要である。ブラウザのブックマーク URL のみ更新する。

## F-05 診断情報を返す

- Mesh 転送失敗時は `fetch`/`connect` の例外を捕捉し、HTTP 503 と JSON (`error`、`reason`、`hint`) で返す。捕捉漏れは Error 1101 になるため必須とする。`vpc-test/src/index.js` の `hint()` 分類 (拒否・DNS・タイムアウト・refused) を流用する。
- 成功時の余計なラッピングはしない。VS Code の応答をそのまま返す。
