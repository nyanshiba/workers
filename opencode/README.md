# opencode proxy (Cloudflare Worker)

opencode の Web UI ↔ サーバ間(モバイルの1ホップ)の通信量を削減するリバースプロキシ Worker です。

A Cloudflare Worker reverse proxy that reduces the traffic between the opencode Web UI and the server (the mobile last hop).

## 概要 / Overview

自宅など private origin で動いている [opencode](https://github.com/sst/opencode) サーバを、
Cloudflare Workers(VPC Network = **MESH** binding)経由で公開する構成のとき、
**Web UI(特にモバイル)↔ サーバ間で流れる無駄なペイロード**を Worker 側で削ります。

削る対象は以下で、いずれも**サーバ↔モデルプロバイダ間の固定回線には影響しません**。
サーバとモバイルの間(1ホップ)だけの最適化です。

- **SSE(`/api/event`)**: 推論ストリーム `session.reasoning.*` と、ツール実行中の一過性ストリーム `session.tool.input.delta` を中継時にドロップ。
- **履歴 API**(`/api/session/{id}/message`): 応答 JSON の assistant `content[]` から `{type:"reasoning"}` パートを除去。

```text
Mobile Web UI ── Workers (this repo) ── VPC Network (MESH) ── opencode server (private origin)
        ◀────── this proxy only trims this hop ──────▶        ◀── fixed line, untouched ──▶
```

## 構成 / Architecture

`index.js` のルーティング:

| 経路 | 処理 |
|---|---|
| ① `/api/event` (SSE) | `lib/sse.js` でフレーム単位にフィルタ。`session.reasoning.*` と `session.tool.input.delta` を落として中継 |
| ② `/api/session/{id}/message...` | `lib/history.js` で応答 JSON から reasoning パートを strip |
| ③ その他 | `lib/ui.js` が GET の `text/html` に CSS を注入したうえで、`lib/cache.js` の `cacheHeaders` が grafana と同条件で Cache-Control を宣言 |

`lib/`:

- `sse.js` — 行単位の状態機械で SSE フレームを parse して `isKept` で選別(O(n) のバッファ処理)。
- `history.js` — 履歴 JSON から reasoning 除去。`stripReasoningFromJson` / `applyHistoryFilter`。
- `cache.js` — Workers Cache 用の宣言的ヘッダ制御(`cacheHeaders`)。キャッシュ可否は Worker が返す Cache-Control だけで決まる。
- `ui.js` — HTML 応答への CSS パッチ注入(`applyUiTweaks`)。

## 設定 / Configuration

コードは `env.X ?? デフォルト` で読むため、vars / secrets のどちらでも上書きできます。

| env | 管理場所 | 既定値 | 説明 |
|---|---|---|---|
| `PRIVATE_BASE` | `wrangler.jsonc` の `vars` | `http://10.0.10.40:49374` | opencode サーバ origin |
| `OPCODE_AUTH_USERNAME` | **secret**(`secret bulk`) | 未設定 | origin への Basic 認証。設定時は常にこの値で `Authorization` を上書きする |
| `OPCODE_AUTH_PASSWORD` | **secret**(`secret bulk`) | 未設定 | 〃 |

認証は env に設定した Basic 認証で origin へ接続します(設定時はクライアント側の
`Authorization` を常にこの値で置き換え)。未設定ならクライアントのヘッダを素通しします。
この構成では Cloudflare Access がクライアント認証を剥がすため、実際のアクセスは
常に「Authorization 無し + env 注入」の経路になります。

## デプロイ / Deploy

前提: 認証済み `bunx wrangler` と、origin へ届く **Workers VPC Network の `cf1:network`** バインディング(`wrangler.jsonc` の `vpc_networks`、`remote: true`)。

```bash
cd opencode

# 認証情報を外部 JSON 1 枚で一括設定(順序: 最初に実行)
cp secrets.json.example secrets.json   # 実値を埋める
./deploy.sh                            # secret bulk + deploy を一括実行

# 手動でも OK:
#   bunx wrangler secret bulk secrets.json
#   bunx wrangler deploy
```

`deploy.sh` の中身は `wrangler secret bulk secrets.json` + `wrangler deploy` のみです。
`secrets.json` には認証情報を1枚にまとめられるため、`wrangler secret put` の個別打鍵は不要です。
`secrets.json` / `.dev.vars` はコミット対象外です(`.gitignore` 済み)。

## ローカル開発 / Local development

```bash
cp .dev.vars.example .dev.vars   # PRIVATE_BASE / 認証(任意)
bunx wrangler dev
```

## フィルタの効果 / Measured results

実測(環境依存・目安):

- SSE(tool 無し 1 プロンプト): `session.reasoning.delta` ≈ 53%、`session.text.delta` ≈ 38%。
  reasoning 系を落とすことでモバイル側の受信を大きく削減。
- SSE(ツール呼び出しあり): reasoning 系 26.8% / `session.tool.input.delta` 16.5% / `session.tool.success` 18.1% / `session.text.delta` 26.4%。
  一過性(reasoning + tool.input.delta)を落とし、履歴に残る `tool.success` と `text.delta` は保持。
- 履歴 API: 148KB → 83KB(約 56% 削減)を確認。

ドロップ対象は**実行中にしか流れず履歴には残らない**ストリームなので、レスポンス内容の欠落はありません。
履歴側は応答 JSON から reasoning パートを除くだけです。

## Web UI への CSS パッチ / UI patch (model name always visible)

opencode の Web UI はメッセージヘッダー(agent 名 · モデル名 · 時刻)を hover 時しか
表示しない。この Worker は **HTML 応答に CSS を1枚注入**して常時表示に変えるため、
プロキシ経由のクライアント(モバイル含む)では追加設定が不要です。

- 注入対象: `content-type: text/html` の GET 応答のみ(SSE / JSON API は素通し)
- 注入位置: `</head>` 直前(`</head>` が無ければ先頭)。marker 付きで冪等
- 対象セレクタ: `[data-slot="user-message-copy-wrapper"]` / `[data-slot="text-part-copy-wrapper"]`
  (upstream: `packages/session-ui/src/components/message-part.css`)
- 効かなくなった場合: upstream 側で data-slot 名が変わったとき。セレクタ不一致だけで
  壊れることはない(表示挙動が従来どおり hover 表示に戻るだけ)。

プロキシを使わず opencode サーバへ直接アクセスする環境向けには、同等の処理をする
ブックマークレットを `bookmarklet/always-model-name.js` に置いてあります。
ファイル内の「1行版」をブックマークの URL に登録してページ上で実行してください。

## キャッシュ / Caching

[Workers Caching](https://developers.cloudflare.com/workers/cache/) を利用(エントリポイントレベル、`wrangler.jsonc` の `"cache": { "enabled": true }`、Wrangler 4.69+ 必須)。

- **ヒット時は Worker が実行されない**(CPU・待ち時間ゼロ)。キャッシュキーには Worker バージョンが含まれるため、**デプロイでキャッシュはリセット**される。
- 載るのは **origin が正の freshness(`max-age`/`s-maxage`)を宣言した GET 200 のみ**(grafana と同条件)。`public` を補って Workers Cache に載せる。favicon・`/assets`・シェル HTML・フィルタ済み応答も区別しない。
- それ以外は **必ず `no-store`**。ヒューリスティックキャッシュで古い応答や切れた SSE ストリームが配信されるのを防ぐ。
- `Set-Cookie` 付き応答は自動 BYPASS になるため、静的応答からは除去。`Authorization` 付きリクエストも自動 BYPASS(この構成では Cloudflare Access がクライアント認証を剥がすため通常発生しない)。
- Access とは共存可能(キャッシュ確認前に Access がエッジで検証済み)。旧 Cache API(`caches.default`)は Access 有効時に公式に利用不可のため、本実装では使用しない。

## 注意 / Notes

- SSE をフィルタするため `content-length` は削除しています(チャンク転送になる)。CSS 注入した HTML 応答も同様です。
- 対象外: opencode サーバとモデルプロバイダ間の通信(固定回線)。