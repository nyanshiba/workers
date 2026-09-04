# linkding MCP

OpenCode などの MCP クライアントから linkding ブックマークを読み取り専用で検索するための MCP サーバーです。
Cloudflare Workers 上で動作し、Cloudflare Access の Managed OAuth による認証、Workers VPC 経由のプライベートネットワーク接続を備えます。

## アーキテクチャ

```
OpenCode (MCP クライアント)
  │  OAuth 2.1 (PKCE) → Cloudflare Access (Managed OAuth)
  ▼
Cloudflare Access ── Cf-Access-Jwt-Assertion ──► Cloudflare Worker ── POST /mcp ──► env.MESH.fetch() ──► linkding
                                                   │
                                                   ├─ 国ゲート: 日本 (JP) 以外は /cdn-cgi/error/500 へ 302
                                                   ├─ JWT 検証: チーム JWKS で Cf-Access-Jwt-Assertion を検証 (jose)
                                                   └─ MCP: リクエスト毎に生成する stateless McpServer (linkding 検索ツール)
```

認証はすべて Access 側で処理します。Worker は自前の OAuth サーバーを持たず、Access が付与する `Cf-Access-Jwt-Assertion` ヘッダの JWT を検証するだけです。

## 前提条件

- Cloudflare アカウント (Workers VPC はベータ期間中、全プラン無料)
- Cloudflare Zero Trust (Access) が有効化され、認証できる IdP とポリシーが用意されていること
- linkding のネットワークに到達できる Cloudflare Mesh ノードまたは Cloudflare Tunnel
- linkding インスタンス (プライベートネットワーク上で稼働)
- bun (依存関係のインストールと実行)
- OpenCode (MCP クライアント) または OAuth 2.1 対応の MCP クライアント

## セットアップ

### 1. リポジトリのクローンと依存関係のインストール

```sh
git clone <this-repo> linkding-mcp
cd linkding-mcp
bun install
```

### 2. VPC ネットワーク (Cloudflare Mesh) の設定

この Worker は `wrangler.jsonc` で `vpc_networks` に `network_id: "cf1:network"` を指定しており、Cloudflare Mesh にアカウント全体でバインドします。linkding インスタンスは、Cloudflare Mesh ノード (旧 WARP Connector) が置かれているネットワーク上、または Cloudflare Tunnel 経由でルーティング公開されているネットワーク上で稼働している必要があります。バインディングの作成には `Connectivity Directory Bind` ロールが必要です。

Cloudflare Mesh のセットアップについては [Cloudflare Mesh のドキュメント](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-mesh/get-started/) を参照してください。

### 3. Access アプリケーション (MCP server) の作成と Managed OAuth の有効化

1. Cloudflare ダッシュボード → **Zero Trust** → **Access controls** → **Applications** に移動します。
2. MCP サーバー用のアプリケーションを作成し、対象のホスト名に Worker のホスト名 (例: `linkding-mcp.<your-subdomain>.workers.dev`) を指定します。
3. **Access policies** で、自分だけが認証を通過できるポリシー (例: 自分のメールアドレスのみ Allow) を設定します。
4. 作成したアプリケーションを開き、**Advanced settings** タブで **Managed OAuth** を有効化して保存します。
5. アプリケーションの概要画面から **Application AUD tag** を控えます。これが後述の `POLICY_AUD` になります。
6. Zero Trust ダッシュボードの URL に含まれるチーム名 (例: `myteam.cloudflareaccess.com` の `myteam`) を控えます。これが後述の `TEAM_DOMAIN` になります。

詳細は [Secure MCP servers](https://developers.cloudflare.com/cloudflare-one/access-controls/ai-controls/secure-mcp-servers/) と [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/) を参照してください。

### 4. シークレットの設定

シークレットの値は `wrangler.jsonc` には含めません。同ファイルの `secrets.required` は必須シークレットの名前を列挙するだけであり、実際の値は下記のファイルで管理します。必要なシークレットは 4 個です。

| シークレット          | 内容                                                                    |
| --------------------- | ----------------------------------------------------------------------- |
| `TEAM_DOMAIN`         | Zero Trust のチーム名 (例: `myteam`)。フルホスト名でも可                |
| `POLICY_AUD`          | 手順 3 で控えた Application AUD tag                                     |
| `LINKDING_API_TOKEN`  | linkding の Settings > Integrations から取得                            |
| `LINKDING_BASE_URL`   | linkding のベース URL (例: `http://linkding.internal:9090`)             |

#### ローカル開発用 (`.dev.vars`)

`src/.dev.vars.example` をコピーして実際の値を設定します。

```sh
cp src/.dev.vars.example .dev.vars
```

`.dev.vars` を編集します。このファイルには秘密情報が含まれるため、リポジトリにコミットしないでください。

```
TEAM_DOMAIN=<手順3で控えたチーム名>
POLICY_AUD=<手順3で控えた Application AUD tag>
LINKDING_API_TOKEN=<linkding の Settings > Integrations から取得>
LINKDING_BASE_URL=http://linkding.internal:9090
```

#### 本番環境用 (`.prod.vars.json`)

本番環境のシークレットは、JSON ファイルにまとめて `wrangler secret bulk` で一括登録します。`src/.prod.vars.json.example` をコピーして値を設定してください。

```sh
cp src/.prod.vars.json.example .prod.vars.json
```

`.prod.vars.json` を編集します:

```json
{
  "TEAM_DOMAIN": "<手順3で控えたチーム名>",
  "POLICY_AUD": "<手順3で控えた Application AUD tag>",
  "LINKDING_API_TOKEN": "<linkding の Settings > Integrations から取得>",
  "LINKDING_BASE_URL": "http://linkding.internal:9090"
}
```

登録します:

```sh
bunx wrangler secret bulk .prod.vars.json
```

`.prod.vars.json` にも秘密情報が含まれるため、リポジトリにコミットしないでください。シークレットを削除する場合は、該当キーを `null` にした JSON を渡します (`{"POLICY_AUD": null}` など)。

### 5. デプロイ

```sh
bunx wrangler deploy
```

デプロイ後に表示される Worker の URL (例: `https://linkding-mcp.<your-subdomain>.workers.dev`) を控えます。手順 3 で指定したホスト名と一致していることを確認してください。

## ローカル開発

```sh
bunx wrangler dev
```

`.dev.vars` に設定した値が自動で読み込まれます。

VPC ネットワークはローカルでは利用できないため、必要に応じて `MESH` バインディングをモックするか、linkding に直接アクセスできるネットワーク環境で開発します。

型チェック:

```sh
bun run type-check
```

## OpenCode からの接続

デプロイ後、OpenCode に MCP サーバーとして登録します。

```sh
# グローバル設定として追加
opencode2 mcp add linkding --global --url https://linkding-mcp.<your-subdomain>.workers.dev/mcp

# 認証フローを実行 (ブラウザが開いて Access のログイン画面が表示される)
opencode2 mcp auth linkding
```

`opencode2 mcp list` で接続状態を確認できます。

他の MCP クライアント (Claude Code, VS Code など) からも OAuth 2.1 経由で接続可能です。各クライアントのドキュメントに従って OAuth の設定を行ってください。

### ブラウザが別マシンの場合 (SSH 先サーバでの実行など)

OAuth フローはサーバの loopback (`http://127.0.0.1:<port>/callback`) へのリダイレクトで完結します。ブラウザが別マシンにあるとリダイレクトが届かないため、SSH ローカルフォワードで繋ぎます。動作確認済みです。

```sh
# 1. サーバで実行する (プロセスは終了させず、表示されるコールバックポートを控える。実績値は 19876)
opencode2 mcp auth linkding

# 2. 手元マシンで別ターミナルからトンネルを張る (ポートは手順 1 の表示に合わせる)
ssh -N -L 19876:127.0.0.1:19876 user@server

# 3. 表示された認可 URL を手元ブラウザで開き、Access ログインを完了する
# 4. リダイレクトがトンネル経由でサーバの待受に届き、フローが完了する
```

注意点:

- `mcp auth` は 1 プロセスだけ起動し、完了まで終了させないこと (state とポートは起動毎に変わる)
- コールバック URL を curl で移植する場合は、クエリ付き完全 URL (`?code=...&state=...` を含む) をダブルクォート付きで叩くこと (クォート漏れや別プロセスへの投げ込みは `OAuth state mismatch` になる)
- 検証は `opencode2 mcp auth list` と `opencode2 mcp debug linkding` で行う

## 提供するツール

### search

linkding のブックマークを検索します。読み取り専用で、ブックマークの作成・変更は行いません。

**引数:**

| 引数     | 型      | 必須 | 説明                                                                 |
| -------- | ------- | ---- | -------------------------------------------------------------------- |
| `q`      | string  | 任意 | 検索クエリ。空白区切りで AND 結合。`#tag` でタグフィルタ。ダブルクォートでフレーズ検索。空文字で全件取得。 |
| `tags`   | string  | 任意 | カンマ区切りタグ (AND)。`#tag1 #tag2` を `q` に追加するのと等価。    |
| `limit`  | number  | 任意 | 最大件数 (1–1000, デフォルト 100)。                                  |
| `offset` | number  | 任意 | ページネーションオフセット (デフォルト 0)。                          |

**戻り値:** JSON 文字列。`count` (総件数) と `results` (ブックマーク配列) を含む。各ブックマークは `url`, `title`, `description`, `tags`, `date_added` を持つ。

## 制約と注意点

- **認証**: すべてのリクエストに有効な `Cf-Access-Jwt-Assertion` が必要です。ヘッダが無い・署名不正・issuer/audience 不一致・期限切れは 401 Unauthorized を返します。設定ミス時は拒否側に倒れます (fail closed)。
- **国ゲート**: 日本 (`JP`) 以外からのリクエストは `/cdn-cgi/error/500` へ 302 リダイレクトし、エッジのブランド付きエラーページを表示します。`wrangler dev` など `request.cf` が無い環境では通過します。
- **MCP プロトコル**: `POST /mcp` のみを受け付けます。パスが違う場合は 404、メソッドが違う場合は 405 Method Not Allowed を返します。
- **読み取り専用**: linkding へのリクエストは GET のみです。ブックマークの作成・変更・削除は行いません。
- **キャッシュなし**: 検索結果のキャッシュは行いません。linkding が VPC 内の SQLite で高速に応答するためです。
- **VPC**: linkding との通信は Workers VPC 経由で行われ、パブリックインターネットには露出しません。

## トラブルシューティング

### 401 Unauthorized

- MCP クライアントが OAuth フローを完了しているか確認します (`opencode2 mcp auth linkding` を再実行)。
- アクセストークン失効時は再認証が必要です (保存内容にリフレッシュトークンが無い場合があるため、失効後は `mcp auth` を再実行する)。
- 繰り返しの `mcp auth` 実行は動的クライアント登録を増やします。`mcp logout` で掃除してから単発で再認証するのが確実です。
- Access アプリで Managed OAuth が有効化されているか確認します。
- `POLICY_AUD` がアプリケーションの Application AUD tag と一致しているか確認します。
- `TEAM_DOMAIN` が正しいチーム名か確認します。
- Access アプリのポリシーで自分が Allow されているか確認します。
- `wrangler tail` でエラーログを確認します。

### エラーページにリダイレクトされる

国コードが `JP` であることを確認します。日本国外からのアクセスは仕様どおり 302 でエラーページに飛ばされます。

### linkding に接続できない

- VPC ネットワークの設定が正しいか確認します。
- linkding インスタンスが同一ネットワーク上で稼働しているか確認します。
- `LINKDING_BASE_URL` が正しいホスト名とポートを指しているか確認します。
- Workers VPC のドキュメントを参照してください。

### ツール呼び出しが HTTP 500 になる

500 は Worker 内の未処理例外を意味します (linkding 側の HTTP エラーはツール結果として返るため区別できます)。以下を順に確認します。

1. `bunx wrangler secret list` で 4 シークレット (`TEAM_DOMAIN`, `POLICY_AUD`, `LINKDING_API_TOKEN`, `LINKDING_BASE_URL`) が揃っているか確認します。特に `LINKDING_BASE_URL` の欠落・誤記は例外になります。
2. linkding 本体が稼働しているか、プライベートネットワーク内から直接叩いて確認します (`/api/bookmarks/?limit=1` に API トークン付き GET)。
3. 再現中に `bunx wrangler tail` を見ます。例外とスタックが出れば原因が特定できます。何も出なければ edge 側の問題です。
4. デプロイ済みコードが最新か `bunx wrangler deployments list` で確認し、古ければ `bunx wrangler deploy` し直します。

### 非対話実行でツールが auto-reject される

`opencode2 run` などの非対話実行では権限要求が自動拒否されます。読み取り専用調査など許可できる場合は `--auto` を付けます。

## 開発

```sh
# 型チェック
bun run type-check

# テスト (まだ作成されていません)
bun run test

# 型定義の再生成 (wrangler types の結果を更新)
bun run cf-typegen
```
