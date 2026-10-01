# mini-flow 增量开发迭代路线图

> 基准：143 tests pass, tsc 零错误

## Day 1 (今天)：数据层 + 元数据管道
- schema.sql: executions 加 retry_of/retry_success_id; 新增 tags/community_nodes 表
- src/db/schema.ts: 新增类型
- src/plugins/types.ts: credentials?
- migrations/increment-01.sql
- 自验：npm test 仍 143 pass, tsc 零错误

## Day 2：外部触发 Webhook + Form
- src/n8n/webhook.ts
- src/index.ts 注册 /webhook/* /form/*

## Day 3：HTTP 节点非 2xx 失败 + 执行 retry
- src/nodes/http-request.ts
- src/n8n/executions.ts POST /:id/retry

## Day 4：节点 properties 补全
- src/plugins/builtin.ts 补 33 节点 properties
- npm run gen:nodes

## Day 5：REST 能力端点
- insights, tags CRUD, import/export, community-nodes

## Day 6：集成测试 + 回归
- 补齐测试，全量回归

全程单分支：iter/2026-10-01
