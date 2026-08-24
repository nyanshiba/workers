#!/usr/bin/env bash
# secrets.json で外部管理している認証情報を一括適用してデプロイする。
#   cp secrets.json.example secrets.json  → 実値を埋める → ./deploy.sh
set -euo pipefail
cd "$(dirname "$0")"

if [[ -f secrets.json ]]; then
  bunx wrangler secret bulk secrets.json
else
  echo "secrets.json がありません。cp secrets.json.example secrets.json して実値を入れてください。" >&2
  exit 1
fi

bunx wrangler deploy