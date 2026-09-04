# workers
Workers / Workers VPC configuration example  
slop注意。使用の際は必ず [Access](https://dash.cloudflare.com/one/) で認証をかけること。

- Workers (サーバレス)
    - **ip**  
    https://ip.nyanshiba.com/
- Workers VPC (オンプレ <- `env.MESH.fetch()` - Workers)  
    - **grafana**  
    originの [grafana/grafana](https://github.com/grafana/grafana) へHTTP接続。  
    ブラウザキャッシュTTL`cache-control: max-age`に従って、CDNにキャッシュ`cf-cache-status: HIT`
    - **satident**  
    originの [exoplanet5/SatIdentifier](https://github.com/exoplanet5/SatIdentifier)(0.0.0.0でlistenするように改造) へHTTP接続。  
    `cache-control: max-age`を上書きしてブラウザ・CDNにキャッシュ
    - **opencode**  
    originの [anomalyco/opencode at v2](https://github.com/anomalyco/opencode/tree/v2) へHTTP接続。  
    基本動作はgrafanaと同様。ただし、OpenCode v2のBasic認証を肩代りし、Reasoningの通信をWorkersで落として通信量を削減。
    - **linkding-mcp**  
    `/mcp`へのPOSTリクエストに応じて、originの [sissbruecker/linkding](https://github.com/sissbruecker/linkding) へHTTP接続。  
    正当なハーネスをAccessのOAuthに基づいて認可。
    - **files**  
    originの [sigoden/dufs](https://github.com/sigoden/dufs) へHTTP接続。  
    基本動作はgrafanaと同様。にFree Tierのアップロード100MB制限を突破する機能を追加。
    - **doh**  
    originの [coredns/coredns](https://github.com/coredns/coredns) へHTTPS接続。  
    デュアルスタックDoHサーバをホスト。originの構成例は [corednsconf/coredns/Corefile@doh](https://github.com/nyanshiba/corednsconf/blob/main/coredns/Corefile%40doh) を参考にされたし。
