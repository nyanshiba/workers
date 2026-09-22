# 個人開発用のリモート VS Code — 導入手順

仕様は `vscode/.agents/rules/specification.md` を参照する。本書は作業者が実施する導入とデプロイの手順書である。

## 前提

- プライベート網内に Linux VM (systemd 利用可) がある。
- VM から Cloudflare Mesh (WARP Connector または Tunnel) 経由で到達できる状態にある。Mesh の位置づけは [Cloudflare Mesh](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-mesh) を参照する。
- 作業者の PC に `wrangler` が入っている (`npx wrangler` でもよい)。導入は [Install/Update Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update) に従う。
- 利用者は単一ユーザーとする。複数人への提供はしない。単一ユーザー前提は [Visual Studio Code Server](https://code.visualstudio.com/docs/remote/vscode-server) の条件と一致する。

## 手順 1: VM に code CLI を導入する

1. VS Code CLI (standalone) を VM のアーキテクチャに合わせて取得し、`code` を PATH に置く。取得元は [Download Visual Studio Code](https://code.visualstudio.com/download) の CLI 欄、または [Developing with Remote Tunnels](https://code.visualstudio.com/docs/remote/tunnels) の standalone install 項 ([代替ダウンロード](https://code.visualstudio.com/#alt-downloads)) とする。端末のみの VM では同項の tarball 展開手順を使う。x64 例は以下である。アーキテクチャ別の値はダウンロード頁で確認する。

```
curl -Lk 'https://code.visualstudio.com/sha/download?build=stable&os=cli-alpine-x64' --output vscode_cli.tar.gz
tar -xf vscode_cli.tar.gz
```

`serve-web` の選択肢は `code serve-web --help` で確認する。背景は [Visual Studio Code Server](https://code.visualstudio.com/docs/remote/vscode-server) と発端の [microsoft/vscode#135856](https://github.com/microsoft/vscode/issues/135856) を参照する。
2. トークンファイルを用意する。公式定義では `--connection-token-file` は起動時に読み、ファイルの中身をトークンとするものである ([serverEnvironmentService.ts](https://github.com/microsoft/vscode/blob/main/src/vs/server/node/serverEnvironmentService.ts))。同定義は配置先を同一ユーザーのみ可読 (`chmod 0700` 相当) とし、指定なし時は起動ごとに UUID を生成する。`--connection-token` は他ユーザーから `ps` で見えるためファイル方式が推奨され、CVE-2024-26165 の修正でファイル受け渡しが導入された ([microsoft/vscode#207491](https://github.com/microsoft/vscode/issues/207491))。下の `openssl` 行は乱数生成の一例であり公式指定ではない。`--connection-token-file` が `serve-web` で無視される不具合は 2024-07 修正分 ([microsoft/vscode#215537](https://github.com/microsoft/vscode/issues/215537)) より前の版にあるため、最近の CLI を使う (`code --version` で確認する)。トークン指定自体は起動の必須条件ではなく、再起動後もブックマーク URL を固定し Worker 側変更を不要とするための運用上の選択である。

```
sudo mkdir -p /etc/vscode
sudo chmod 700 /etc/vscode
openssl rand -hex 32 | sudo tee /etc/vscode/serve-web-token > /dev/null
sudo chmod 600 /etc/vscode/serve-web-token
```

3. 初回は手動起動し、ライセンス同意と待受を確認する。ライセンス条項は [VS Code Server ライセンス](https://aka.ms/vscode-server-license) に従う。

```
code serve-web --host 0.0.0.0 --port 8000 --connection-token-file /etc/vscode/serve-web-token --accept-server-license-terms --disable-telemetry
```

`Web UI available at http://0.0.0.0:8000?tkn=...` と出ることを確認する。`?tkn=` の値は保管・共有しない。

4. VM 内から到達を確認する。確認は GET で行う (`--head` は 405 になるため使わない)。

```
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:8000/?tkn=$(sudo cat /etc/vscode/serve-web-token)"
```

正トークンで 302 または 200 であればよい。`?tkn=` なしは 403 になる。応答がない場合は `ss -ltn` で `0.0.0.0:8000` の LISTEN を確認する。

5. 常駐化する場合は systemd unit を登録する。

```
# /etc/systemd/system/vscode-serve-web.service
[Unit]
Description=VS Code serve-web (single user)
After=network.target

[Service]
Type=simple
Environment=HOME=/root
ExecStart=/usr/local/bin/code serve-web --host 0.0.0.0 --port 8000 --connection-token-file /etc/vscode/serve-web-token --accept-server-license-terms --disable-telemetry
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

```
sudo systemctl daemon-reload
sudo systemctl enable --now vscode-serve-web.service
```

`ExecStart` のパスは `which code` の結果に合わせる。`--without-connection-token` は付けない。`Environment=HOME=/root` は HOME 未設定環境での `Home directory not found` を抑止する。有効化直後に以下で token-file 指定の有効と疎通を確認する。`grep` に出ない場合 (`;` などで無効化されている場合) はトークン不一致の `Unauthorized client refused` が出続ける。

```
systemctl cat vscode-serve-web.service | grep connection-token-file
curl -s -o /dev/null -w '%{http_code}\n' "http://127.0.0.1:8000/?tkn=$(sudo cat /etc/vscode/serve-web-token)"
```

## 手順 2: Worker をデプロイする

1. `vscode/wrangler.jsonc` の `vars.PRIVATE_BASE` を VM の実アドレスに合わせる。形式は `http://<private-ip>:8000` とし、ホスト名ではなく IP を指定する。ポート変更時は serve-web 側の `--port` と同時に変更する。`vpc_networks` の `network_id: cf1:network` への束縛と `fetch()` / `connect()` の使い分けは [VPC Networks](https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks) と [Workers Binding API](https://developers.cloudflare.com/workers-vpc/api) に従う。Mesh への最小構成は [Connect Workers to Cloudflare Mesh](https://developers.cloudflare.com/workers-vpc/examples/connect-to-cloudflare-mesh/) を参照する。
2. 本番用トークンを secret `TKN` として登録する。`wrangler.jsonc` の `vars` には置かない。Worker は上流への `?tkn=` を除去し、`Cookie: vscode-tkn=<正値>` を付与するため、ブラウザ側の入力も Cookie 保存も不要になる。

```
sudo cat /etc/vscode/serve-web-token | tr -d '\r\n' | npx wrangler secret put TKN
```

末尾改行が混入すると 403 になるため `tr` で除去する。wrangler を PC 側で動かす場合は、値の転記を避けるため SSH パイプで直接流す。

```
ssh <vm> 'sudo cat /etc/vscode/serve-web-token' | tr -d '\r\n' | npx wrangler secret put TKN
```

3. デプロイする。`deploy` の扱いは [Wrangler Commands](https://developers.cloudflare.com/workers/wrangler/commands) を参照する。

```
cd vscode
npx wrangler deploy
```

4. Mesh 経由の疎通を確認する。

```
curl 'https://<worker>/__probe?mode=fetch'
curl 'https://<worker>/__probe?mode=connect'
```

`fetch` が `http response`、`connect` が `tcp connected` であれば到達している。`fetch` 応答の `hasTkn` が `false` の場合は secret 未束縛または旧コード稼働であり、`secret put` と `deploy` を確認する。失敗時は応答の `hint` に従い、Gateway の Logs > Network と VPC Service Metrics を突き合わせる。Gateway ログの見方は [Gateway activity logs](https://developers.cloudflare.com/cloudflare-one/insights/logs/gateway-logs) を、VPC 側 Metrics の見方は [Observability for Workers VPC Services](https://developers.cloudflare.com/changelog/post/2026-03-20-metrics-and-settings-dashboard) を参照する。

転送部 (`src/index.js`) は `Host` を上書きせず、`X-Forwarded-Host` に公開ホスト名、`X-Forwarded-Proto` に公開スキームを入れて転送し、HTML 応答内の origin を公開 origin に書換える (`http→https`、`ws→wss`、`Location`・`CSP` を含む)。serve-web は `X-Forwarded-Host` を `remoteAuthority` と `resourceUrlTemplate` に反映するため、私的アドレスのままではブラウザが私的宛 (`wss://<private-ip>`、混在コンテンツ) に接続しにいき壊れる。`Host` 単独の上書きは Workers が無視し、一致しない場合に 403 になるため使わない。転送部を変更した場合は再デプロイする。

## 手順 3: ブラウザで受け入れる

1. `https://<worker>/` を PC ブラウザで開く。`?tkn=` の入力は不要である (Worker が secret `TKN` を Cookie 付与するため)。静的 UI が表示されることを確認する。
2. ターミナルを開いて入力できること、ファイル保存ができることを確認する (WebSocket 経路の確認)。Worker の WebSocket 転送の前提は [WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets) と [Using the WebSockets API](https://developers.cloudflare.com/workers/examples/websockets) に従う。
3. Access 未認証で拒否されることを確認する。serve-web 単体のトークン拒否確認は行わない (Worker が上流へ正値を付与するため)。

初回アクセス時に `downloading, please wait` の 202 応答が出る場合がある。自動再読込で解消する。

トークン (再) 生成時は secret `TKN` を更新して再デプロイし、ブラウザはキャッシュ無視再読込で開く。ブックマーク URL の更新は不要である。旧トークンのままでは読込後の live 接続が全拒否され (`Unauthorized client refused`、`File system provider ... is not available`)、キャッシュされた画面だけが表示される場合がある。プライベート網からの平文 HTTP 直アクセスは疎通確認用とし、常用は `https://<worker>/` 経由とする。

接続後の切り分けは層で行う。`GET /?tkn=` が 302、`/` が cookie のみで 200、`Upgrade: websocket` が 101 であれば HTTP 層は正常である。ログの `Unauthorized client refused` の `[]` 内 ID はブラウザ側 `reconnectionToken` の接頭辞と対応する。101 の WS が拒否される場合はブラウザ側の旧状態 (cookie・キャッシュ) を疑い、site データ削除または新規プロファイルで `https://<worker>/` から開き直す。組込拡張 4 件 (git-base、github-authentication、emmet、merge-conflict) の `dist/browser` 404 は 1.138.0 のパッケージに起因し、サーバ再取得では解消しない。

## 運用

- トークン漏えい時はトークンファイルを再生成し、secret `TKN` を更新して再デプロイする。ブックマーク URL の更新は不要である。
- 障害時は `wrangler tail` の `mesh fetch failed`、VPC Service Metrics のエラー分類、serve-web の標準出力を順に見る。`tail` の操作は [Real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs) と [`wrangler tail`](https://developers.cloudflare.com/workers/wrangler/commands/general/#tail) を、Worker の指標と 1101 の意味は [Metrics and analytics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics) と [Errors and exceptions](https://developers.cloudflare.com/workers/observability/errors) を参照する。
- 変更時は `PRIVATE_BASE`・`--port`・トークンの三点を同時に確認する。

## 出典・ダウンロード

- VS Code CLI の取得: [Download Visual Studio Code](https://code.visualstudio.com/download) の CLI 欄、[Developing with Remote Tunnels](https://code.visualstudio.com/docs/remote/tunnels) の standalone install 項
- VS Code Server の条件 (単一ユーザー、ライセンス、telemetry): [Visual Studio Code Server](https://code.visualstudio.com/docs/remote/vscode-server)、ライセンス本文は [VS Code Server ライセンス](https://aka.ms/vscode-server-license)
- 自己ホスト要求の発端: [microsoft/vscode#135856](https://github.com/microsoft/vscode/issues/135856)
- トークンファイル方式 (定義、UUID 既定、2024-07 修正): [serverEnvironmentService.ts](https://github.com/microsoft/vscode/blob/main/src/vs/server/node/serverEnvironmentService.ts)、[microsoft/vscode#215537](https://github.com/microsoft/vscode/issues/215537)
- ファイル方式の理由 (ps 可視性、CVE-2024-26165): [microsoft/vscode#207491](https://github.com/microsoft/vscode/issues/207491)
- VPC Networks の束縛 (`cf1:network`、`fetch` / `connect`): [VPC Networks](https://developers.cloudflare.com/workers-vpc/configuration/vpc-networks)、[Workers Binding API](https://developers.cloudflare.com/workers-vpc/api)、最小構成は [Connect Workers to Cloudflare Mesh](https://developers.cloudflare.com/workers-vpc/examples/connect-to-cloudflare-mesh/)
- Mesh (旧 WARP Connector) の位置づけ: [Cloudflare Mesh](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-mesh)
- wrangler の導入と実行: [Install/Update Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update)、[Wrangler Commands](https://developers.cloudflare.com/workers/wrangler/commands)
- WebSocket 転送の前提: [WebSockets](https://developers.cloudflare.com/workers/runtime-apis/websockets)、[Using the WebSockets API](https://developers.cloudflare.com/workers/examples/websockets)
- 観測 (Gateway ログ、VPC Metrics、tail、指標、1101): [Gateway activity logs](https://developers.cloudflare.com/cloudflare-one/insights/logs/gateway-logs)、[Observability for Workers VPC Services](https://developers.cloudflare.com/changelog/post/2026-03-20-metrics-and-settings-dashboard)、[Real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs)、[Metrics and analytics](https://developers.cloudflare.com/workers/observability/metrics-and-analytics)、[Errors and exceptions](https://developers.cloudflare.com/workers/observability/errors)
