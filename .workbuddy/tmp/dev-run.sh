#!/usr/bin/env bash
# 本地启动 mini-flow Worker 用于端到端验证
export PATH="/usr/bin:/bin:$PATH"
export WRANGLER_SEND_METRICS=false
export CI=1
export NO_COLOR=1
NODE="C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
cd "F:/Documents/GitHub/mini-flow" || exit 1
W="node_modules/wrangler/bin/wrangler.js"

echo "### 1) init local D1"
"$NODE" "$W" d1 execute mini-flow-db --file=schema.sql --local 2>&1
echo "### d1 exit=$?"

echo "### 2) start dev server"
"$NODE" "$W" dev --local --ip 127.0.0.1 --port 8787 2>&1
echo "### dev exited=$?"
