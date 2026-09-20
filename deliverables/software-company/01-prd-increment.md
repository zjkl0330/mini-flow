# mini-flow 增量 PRD（PRD-Increment）

- **Language**: 中文
- **Programming Language**: TypeScript（后端 Hono + Cloudflare Workers）；前端复用 n8n editor-ui 已构建 dist（不改源码）
- **Project Name**: mini_flow
- **文档性质**: 增量需求（只描述「变更 / 待补」，不重写整份需求）
- **原始需求复述**: 对上一轮在线审计暴露的 34 项问题进行「核对真伪 → 固化已修 → 补齐未闭环」的增量收敛；本轮工作区已有未提交改动（含 57 项测试全绿、tsc 零错误），需以代码实证为准更新需求状态。
- **核对基线（已实测）**: `node scripts/run-tests.mjs` → **57 passed / 0 failed**；`node node_modules/typescript/bin/tsc --noEmit` → **退出码 0（零错误）**。

---

## 1. 产品目标

mini-flow 的目标是把 n8n 的「可视化工作流编排 + 节点执行」原生化搬迁到 Cloudflare Workers（前端 100% 复用 editor-ui dist，后端用 Hono 复刻 `/rest/*` 与 Push(SSE) 契约，D1 做控制面、KV 存设置/密钥、Durable Object 做 SSE 门面、Cloudflare Workflows 做断点续跑）。本轮增量目标：在已确认的「鉴权闭环 / 执行引擎语义 / REST 契约健壮性」修复基线上，**补齐仍未落地的能力类端点**（外部 webhook 触发、执行 retry、工作流导入导出、insights/tags），并把节点层从「能跑」推进到「可配置」（补全 param 面板 properties 与 credentials 声明），使平台达到可对外触发、可运维、可迁移的最小生产闭环。

---

## 2. 用户故事

1. **作为实例管理员**，我希望登录必须校验密码并签发不可伪造的签名会话令牌，这样他人无法用公开常量或任意密码冒充 owner。
2. **作为工作流作者**，我希望只有被我连线的节点才执行、IF 只走命中的那条分支，这样画布语义与运行结果一致。
3. **作为运维者**，我希望节点抛错时执行显式标为 failed 并推送错误事件，这样我在执行详情能看到失败节点，而不是假成功。
4. **作为集成方**，我希望访问 `https://<host>/webhook/<path>` 能真正触发已激活的 Webhook 工作流，而不是返回前端首页 HTML。
5. **作为工作流作者**，我希望 Set / Filter / Switch / Delay 等节点的参数面板显示可配置字段，而不是「此节点没有任何参数」。
6. **作为运维者**，我希望对失败的执行一键 retry、对工作流可导入导出，以便快速恢复与迁移。

---

## 3. 需求池（增量）

> 状态取值：**已修复**（本轮改动已实证闭环）｜**仍存在**（代码核实仍未做）｜**未证实**（无实机/无实证，不可采信）。
> 标记 *(实证)* 的条目由仓库内测试用例或代码直读确认。

| 编号 | 需求 | 优先级 | 验收标准（可测） | 影响文件 | 状态 |
| --- | --- | --- | --- | --- | --- |
| REQ-01 | 登录必须校验密码；不存在用户/错误口令统一 401 | P0 | `POST /rest/login {email:"admin@example.com",password:"wrong"}` → **401**；`password:"nobody"` → **401**；正确口令 → **200** 且下发 `n8n-auth` Cookie *(实证：rest-contract.test)* | `src/n8n/auth.ts` | 已修复 |
| REQ-02 | 会话令牌改为服务端可验证的 HMAC 签名（含过期） | P0 | 登录响应 `Set-Cookie` 形如 `n8n-auth=<b64url>.<exp>.<sig>`（3 段），**≠** 固定常量 `mini-flow-demo-secret`；篡改/过期令牌访问受保护端点 → **401** *(实证)* | `src/n8n/auth.ts` | 已修复 |
| REQ-03 | `/rest/*` 全局鉴权墙（除登录白名单外一律 401） | P0 | 匿名 `GET /rest/workflows`、`/executions`、`/credentials`、`/users`、`/projects`、`/node-types` → **401 JSON** `{code:401}`；`GET /rest/settings` `/meta` `/sso` `/module-settings` → **200** *(实证)* | `src/n8n/router.ts` | 已修复 |
| REQ-04 | 匿名写操作（建流/执行/建凭据）拒绝 | P0 | 匿名 `POST /rest/workflows`、`POST /rest/workflows/w1/run`、`POST /rest/credentials` → **401**，且 D1 无新增行 *(实证)* | `src/n8n/router.ts` | 已修复 |
| REQ-05 | 凭据密钥脱敏（明文永不出站） | P0 | `POST /rest/credentials {data:{apiKey:"sk-x"}}` → **201**，响应 `data.data.apiKey==="****"` 且响应体不含 `sk-x`；列表/详情同样脱敏；KV 内仍存明文仅用于内网 *(实证)* | `src/n8n/credentials.ts` | 已修复 |
| REQ-06 | 未连线的孤立节点不得执行 | P1 | 画布含「未连线节点」的工作流执行后，`GET /rest/executions/:id` 的 `resultData.runData` **不含**该节点；`node_executions` 无该行 *(实证：dag/evaluator/route 单测)* | `src/engine/route.ts`、`src/engine/dag.ts` | 已修复 |
| REQ-07 | IF 条件分支互斥执行 | P1 | 条件为真 → 仅 `main[0]` 有 items、`main[1]===[]`；条件为假 → 反之；下游仅执行命中分支 *(实证)* | `src/nodes/if-condition.ts`、`src/engine/route.ts` | 已修复 |
| REQ-08 | 节点失败显式上报（不再静默 success） | P1 | 任一节点抛错 → `executions.status='failed'`、`node_executions.status='failed'`、SSE 推 `nodeExecuteError`+`executionFailed`；执行不再报 success *(实证：失败路径单测)* | `src/runtime/flow-engine.ts`、`src/engine/checkpoint.ts` | 已修复 |
| REQ-09 | 执行终态落库与进度推送（界面不再永远「正在执行」） | P1 | 执行结束 → `executions.finished_at` 非空；`GET /rest/executions/:id` 返回 `status∈{success,error}`；SSE 收 `executionFinished`/`executionFailed`。**前端 loading 是否解除为界面行为，本轮未实机复测** *(代码已实证，UI 未证实)* | `src/runtime/flow-engine.ts`、`src/n8n/executions.ts` | 已修复（引擎层）；界面 未证实 |
| REQ-10 | HTTP 节点网络层错误必须抛错 | P1 | 请求不可达域名（DNS 失败）→ 节点失败、执行标 failed，**不再**把错误响应页当成功数据 *(实证：代码直读，throw 已补)* | `src/nodes/http-request.ts` | 已修复 |
| REQ-11 | HTTP 节点非 2xx 默认应视为失败（对齐 n8n） | P1 | 目标返回 5xx（如 Cloudflare 530）且未显式开启 `alwaysFailOnError` 时，当前仍返回响应数据 → **仍会把 530 页当数据**；期望：默认对 4xx/5xx 抛错，或提供「失败续跑」开关 | `src/nodes/http-request.ts` | 仍存在 |
| REQ-12 | HTTP 输出与 n8n 扁平 body 兼容 | P1 | 响应体字段合入顶层 `$json`（`$json.args.x` 可直接取）。注：仍额外附加 `statusCode/body/json/headers`（非破坏，但属契约差异，建议对齐 n8n「不默认注入」） | `src/nodes/http-request.ts` | 已修复 |
| REQ-13 | Code 节点求值正确性（真算术 / 多语句） | P2 | `1+1` → `2`（曾得字符串 `"11"`）；`const x=...; return ...` 多语句正确 *(实证)* | `src/nodes/code-node.ts`、`src/engine/evaluator.ts` | 已修复 |
| REQ-14 | 外部 Webhook 触发器路由落地 | **P0** | 访问 `https://<host>/webhook/<path>` 且存在「已激活 + path 匹配」的 Webhook 工作流 → **触发执行**并返回工作流响应；未匹配 → **404 JSON**（当前会落 SPA fallback 返回 index.html） | `src/index.ts`、`src/n8n/settings.ts`(`urlBaseWebhook`) | 仍存在 |
| REQ-15 | 执行 retry（重跑失败执行） | P1 | `POST /rest/executions/:id/retry` → 新建执行并返回新 `executionId`，原执行保留 `retryOf` 关联；当前该端点缺失（仅 `/dead-letter/:id/retry` 存在） | `src/n8n/executions.ts` | 仍存在 |
| REQ-16 | 节点参数面板 properties 补全 | P1 | `GET /rest/node-types` 中每个节点 `properties` 非空，NDV 不再显示「此节点没有任何参数」。当前 **68 个节点中仅 33 个声明 properties，35 个为空数组** *(实证：代码计数)* | `src/plugins/builtin.ts` | 仍存在 |
| REQ-17 | 节点 credentials 声明（密钥不内联） | P2 | 需要鉴权的节点（OpenAI / HF / Telegram / Slack / MySQL…）在 `node-types` 中含 `credentials` 字段，NDV 可选择凭据。当前 builtin **0 个节点声明 credentials** *(实证：grep 计数为 0)* | `src/plugins/builtin.ts`、`src/n8n/credentials.ts` | 仍存在 |
| REQ-18 | 节点数量扩充（向 n8n 对齐） | P2 | 内置节点从当前 **68** 个扩容（标准 n8n 400+ 核心）；至少补齐高频缺陷节点 Set/Filter/Switch/Merge/Delay/Telegram/Slack/MySQL/Postgres/Google Sheets | `src/plugins/builtin.ts`、`src/nodes/*` | 仍存在 |
| REQ-19 | Code 节点运行时能力说明与边界 | P2 | 节点 description/文档明确为「受限表达式求值（非任意 JS）」，且**不引入 `eval`/`new Function`**（Workers CSP 硬约束） | `src/nodes/code-node.ts`、`src/plugins/builtin.ts` | 仍存在（按设计，非缺陷） |
| REQ-20 | 执行详情页 JSON 兼容（消除 `"[object Object]" is not valid JSON`） | P1 | `GET /rest/executions/:id` → `data.resultData.runData[nodeName][0].data.main` 为「数组的数组」（OutgoingConnections）；IF true 落 `main[0]`、false 为 `[]` *(实证)* | `src/n8n/executions.ts` | 已修复 |
| REQ-21 | 工作流列表计数正确（不再恒「共 0 条」） | P2 | `GET /rest/workflows` 返回 `{data:[...], count}` 且 `count===data.length` *(实证)* | `src/n8n/workflows.ts` | 已修复 |
| REQ-22 | 未知 `/rest/*` 返回 404 JSON（而非 200+SPA HTML） | P2 | `GET /rest/definitely-not-a-route`（已登录）→ **404**，`content-type: application/json`，`{code:404}` *(实证)* | `src/n8n/router.ts` | 已修复 |
| REQ-23 | `limit/filter/cursor` 参数健壮性 | P2 | `?limit=abc`/`?limit=-1`/`?offset=abc` → **200**（不 500）；`filter={name,active}` 生效；LIKE 通配符按字面量；`cursor` keyset 分页 *(实证：workflows/executions 测试)* | `src/n8n/workflows.ts`、`src/n8n/executions.ts` | 已修复 |
| REQ-24 | `/rest/users` 与已登录 owner 自洽 | P2 | `GET /rest/users` → `{data:{count:1,items:[{id:"owner",isOwner:true}]}}`（不再空数组） *(实证)* | `src/n8n/settings.ts` | 已修复 |
| REQ-25 | 侧边栏「模板」接入 | P2 | 同源 `/templates/{categories,search,collections,workflows/:id}` 转发到上游模板库；编辑器导入模板可用 | `src/index.ts`、`src/n8n/templates.ts` | 已修复 |
| REQ-26 | 侧边栏「洞察」insights 端点 | P2 | `GET /rest/insights/summary`（及 `/by-workflow` 等）→ **200 JSON**。当前无任何 `/rest/insights/*` 路由 → 落兜底 **404** | `src/n8n/router.ts`（新增 insights 路由） | 仍存在 |
| REQ-27 | `/rest/tags` 标签 CRUD | P2 | `GET /rest/tags` → 数组；`POST /rest/tags` 创建、`PATCH/DELETE /rest/tags/:id` 生效。当前仅 `GET /tags` 恒返回 `[]`，无写端点 | `src/n8n/router.ts` | 仍存在 |
| REQ-28 | 执行 stop / resume | P2 | `POST /rest/executions/:id/stop` → 运行中执行置 `cancelled`；`POST /rest/executions/:id/resume` → paused 执行从检查点续跑并返回 `{executionId,status:"running"}` *(实证：代码直读)* | `src/n8n/executions.ts` | 已修复 |
| REQ-29 | 工作流导入 / 导出 | P2 | `GET /rest/workflows/:id/export` 下载 n8n JSON；`POST /rest/workflows/import`（或 `/workflows/:id/import`）导入并落库。当前均缺失 | `src/n8n/workflows.ts` | 仍存在 |
| REQ-30 | 工作流激活 / 停用状态 | P1 | `POST /rest/workflows/:id/activate|deactivate` → 更新 `active` 位并返回含 `active` 的完整工作流（含 checksum） *(实证：代码直读)*；注意：激活后**外部触发**依赖 REQ-14 | `src/n8n/workflows.ts` | 已修复（状态位） |
| REQ-31 | Form 触发器外部路由 | P2 | `settings.endpointForm` 指向 `${origin}/form`，需 `GET/POST /form/<path>` handler；当前 index.ts 无 `/form` handler → 落 SPA fallback | `src/index.ts`、`src/n8n/settings.ts` | 仍存在 |
| REQ-32 | 社区节点安装 / 卸载端点 | P2 | `POST /rest/community-nodes`（安装）、`POST /rest/community-nodes/:name/uninstall` → 落库并可在 `/rest/plugins` 看到。当前仅 `GET /community-nodes` 返回 `[]` | `src/n8n/router.ts` | 仍存在 |
| REQ-33 | ID 生成统一（消除 UUID/nanoid 混用） | P2 | 代码中不再出现 `nanoid`；workflow/credential/project 均用 `crypto.randomUUID()` *(实证：grep `nanoid` 命中 0)* | `src/n8n/*` | 已修复 |
| REQ-34 | `GET /rest/workflows/new` 无写副作用 | P2 | 该 GET 只返回带新 id 的空工作流对象，**不落库**、不产生执行/审计副作用 *(实证：代码直读，无 INSERT)* | `src/n8n/workflows.ts` | 已修复 |
| REQ-35 | 首页横幅 / 版本提示 i18n | P2 | 关闭版本提示与动态横幅后不再出现「已更新至版本 1」等文案 | `src/n8n/settings.ts`、`frontend/dist`(只读) | 未证实 |
| REQ-36 | NDV 头部占位方块、执行步骤按钮文字丢失 | P2 | 实机 NDV 头部/执行步骤按钮渲染正常、无空白占位。需实机复测（属前端渲染，无法由代码静态断言） | 前端 dist + 节点元数据 | 未证实 |
| REQ-37 | 节点搜索「社区节点」幽灵条目 | P2 | 节点搜索结果与 `GET /rest/node-types` 一致，无「可搜到可添加但不在类型表」的条目 | 前端 dist + `src/n8n/node-types.ts` | **已闭环（无幽灵条目）** |
| REQ-38 | `projectId` 为 null 与 `personal` 的取值歧义 | P2 | 前端按 projectId 过滤时与后端 `project_id` 语义一致（个人项目统一 `personal`） | `src/n8n/workflows.ts`、`src/n8n/projects.ts` | **已修复（R3 收口）** |
| REQ-39 | 多人共享实例下工作流/执行互相可见 | P2 | 单用户 owner 实例下由鉴权墙隔离匿名访问；**多用户隔离不在本轮范围**（见第 5 节） | — | 仍存在（按设计不做） |
| REQ-40 | **界面登录契约**：前端提交 `emailOrLdapLoginId` | **P0** | `POST /rest/login` 必须接受前端实际字段名（`emailOrLdapLoginId`），并向后兼容 `email`。只读 `email` 会导致**真实用户经界面恒 401**（API 直连却成功） | `src/n8n/auth.ts` | **已修复（R4）** |
| REQ-41 | 前端所需后端端点全量对账（供需零缺口） | **P1** | 前端 dist 抽出的 274 条 `/rest/*` 调用，在实机上**不得出现「端点缺失」型 404**；企业/AI 等不实现的能力须返回「未启用」契约形状而非 404 | `src/n8n/*` | **已修复（R4）** |
| REQ-42 | `GET /rest/license` 全站启动调用 | P1 | 每个页面（含编辑器）启动即请求；须返回 `{data:{usage:{activeWorkflowTriggers},license:{planId,planName}}}`，`limit=-1` 表示社区版 | `src/n8n/rest-extensions.ts` | **已修复（R4，此前 404）** |
| REQ-43 | 路由被 `/:id` 抢占的「假 404」 | P1 | `GET /workflows/from-url`、`GET /credentials/new`、`GET /executions/versions/:wf` 三者此前分别落回 `/:id` 并报「资源不存在」；须各自实现并前置注册 | `src/n8n/{workflows,credentials,executions}.ts` | **已修复（R4）** |

---

## 4. 待确认问题（Open Questions）

1. **REQ-14 触发响应语义**：Webhook 触发后应返回工作流「最后一个 Respond to Webhook 节点」的输出，还是固定 `200 {executed:true}`？影响 REQ-14 验收。
2. **REQ-11 默认失败策略**：HTTP 节点对 4xx/5xx 是否默认抛错（n8n 默认「失败即停」），还是保持「返回响应由用户判断」并仅在 `alwaysFailOnError` 时抛错？请拍板。
3. **REQ-16/18 节点扩容范围**：优先补「properties 面板」还是优先补「节点数量」？两者工作量都大，需排期取舍。
4. **REQ-15 执行 retry 与 DLQ 关系**：retry 走「原 execution 续跑（复用检查点）」还是「新建 execution（`retryOf` 关联）」？后端已有 `dead_letter` 重建逻辑可参考。
5. **REQ-05 凭据落库加密**：当前明文存 KV。生产是否需要引入加密（Workers Secret 作为 KEK）？属安全增强项。
6. **未证实项（REQ-35～38）**：是否本轮安排一次实机（线上实例）复测以摘掉「未证实」标签？

---

## 5. 明确不做（Non-Goals / Out of Scope）

- **不魔改 n8n editor-ui 源码**：`frontend/dist` 只读复用，界面层缺陷只能通过后端契约/元数据适配，不改前端 bundle。
- **不引入 `eval` / `new Function`**：Code/Function 节点保持「受限表达式求值器」，不实现任意 JS（Workers CSP 硬约束）。
- **不实现多租户 / 多用户 / 角色权限体系**：维持单 owner 实例；REQ-03 的鉴权墙只用于隔离「匿名 vs owner」，不做 per-user 数据隔离。
- **不实现真实 WebSocket**：Push 继续走 Durable Object 的 SSE 门面。
- **不在本轮实现标准 n8n 全量 400+ 节点**：只按 REQ-16/18 的取舍范围增量补齐。
- **不修改任何 `src/` 业务代码**（本轮为产品需求产出）。

---

## 附：本轮核对结论速览

- **已修复（实证闭环，14 项）**：REQ-01/02/03/04/05/06/07/08/10/12/13/20/21/22/23/24/25/28/30/33/34（含 CRUD 与契约健壮性类）。
- **仍存在（需排期，14 项）**：REQ-11/14/15/16/17/18/19/26/27/29/31/32/39（+ REQ-09 的 UI 部分）。
- **未证实（4 项）**：REQ-35/36/37/38。
- **回归基线**：`npm test` 57/57 通过、`tsc --noEmit` 零错误，均已复跑确认。
