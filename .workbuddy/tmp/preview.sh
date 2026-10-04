#!/usr/bin/env bash
# 本地预览：初始化本地 D1 并启动 wrangler dev（离线优先，避免联网卡住）
set -u
cd "F:/Documents/GitHub/mini-flow" || exit 1
export PATH="/usr/bin:/bin:/h/node.js:/h/node.js/node_global:$PATH"
export WRANGLER_SEND_METRICS=false
export WRANGLER_SKIP_DEPENDENCY_CHECK=1
export CI=1
export NO_UPDATE_NOTIFIER=1
export NODE_OPTIONS="--no-warnings"

NODE="C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
WRANGLER_BIN=""
for c in node_modules/wrangler/bin/wrangler.js node_modules/wrangler/wrangler-dist/cli.js; do
  if [ -f "$c" ]; then WRANGLER_BIN="$c"; break; fi
done
if [ -z "$WRANGLER_BIN" ]; then
  WRANGLER_BIN=$(ls node_modules/wrangler/bin/*.js 2>/dev/null | head -1)
fi
echo "WRANGLER_BIN=$WRANGLER_BIN"

echo "=== 1) 初始化本地 D1 ==="
"$NODE" "$WRANGLER_BIN" d1 execute mini-flow-db --file=schema.sql --local 2>&1 | tail -20
echo "D1_EXIT=$?"

echo "=== 2) 启动 wrangler dev (port 8787) ==="
exec "$NODE" "$WRANGLER_BIN" dev --port 8787 --ip 127.0.0.1 2>&1
