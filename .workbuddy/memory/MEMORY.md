# mini-flow 项目长期记忆

## 项目本质
把 n8n 的「可视化工作流编排 + 节点执行」原生化搬迁到 Cloudflare Workers。
前端 **100% 复用 n8n editor-ui 的已构建 dist**（`frontend/dist`，**不魔改源码**）；后端用 Hono 复刻 `/rest/*` + Push(SSE) 契约。
权威决策见仓库根 `DECISIONS.md`，架构总览见 `README.md`。

## 技术栈与绑定
Hono + TypeScript + Cloudflare Workers；D1(控制面) / KV(设置·密钥) / Durable Object(SSE) / Cloudflare Workflows(断点续跑)；cron `*/15 * * * *`。

## 开发与验证约定（重要）
- **Node**：`C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-3/node.exe`（bash 里用绝对路径）。
- **门禁**（每次提交前必过）：
  - `".../node.exe" node_modules/typescript/bin/tsc --noEmit` → 必须零错误
  - `".../node.exe" scripts/run-tests.mjs`（= `npm test`）→ 必须全绿（截至 2026-09-21 为 **208 例**）
  - 新增用例后做**反向验证**：注入缺陷确认用例转红，再完整还原。
- **测试夹具**：`tests/helpers/env.ts` 的 `makeEnv()` 用 `node:sqlite` 起真实 SQLite 当 D1 垫片，schema 来自 `schema.sql`；`loginCookie(app, env)` 走真实 `/rest/login`。集成测试直接对 `restApi` / 真实 `src/index.ts` 发 `app.request()`。
- **本地预览**：`wrangler dev` 在 port 8787。**必须绕开 `npx`**（会联网卡死），直接用 `node node_modules/wrangler/bin/wrangler.js dev`。
  **必须先 `cp .dev.vars.example .dev.vars`**（`.dev.vars` 已 gitignore）：自 SEC-1 收口起，
  凭据未配置时实例「失败关闭」（`/rest/login` 503、受保护路由 401），不再有可用的默认口令。
  本地口令见 `.dev.vars.example`（`mini-flow-local-dev-password`）。
- **同文件编辑必须串行**：一条消息里对同一文件发两个 Edit，后写会用陈旧快照覆盖前写（曾致 `auth.ts` 三处不一致 → 登录 500）。批量改同一文件请用整文件 Write。
- **`wrangler dev` 热重载源码但不重载 `.dev.vars`**：改环境变量必须换端口/重启实例。上一会话遗留的 dev 进程会占住端口，新实例会静默无法绑定（无输出、看似 running）。

## Code 节点（受限求值器）语义 —— 改动前必读
Workers 禁用 `eval`/`new Function`，故 `src/engine/evaluator.ts` 是自研受限求值器（白名单 token + 递归下降）。
支持：字段引用、算术/比较/逻辑/三目、数组与对象字面量（含 `...` 展开）、箭头函数 `x => expr`（含多参 `(i, idx) =>`）、
`items` / `$input.all()|first()|last()` / `$json` / `$now` / `env`、成员方法 `.map|.filter|.reduce|.forEach|.find|.join|.slice|.length`。
不支持（**显式失败 + 能力提示**，属既定设计）：块体箭头、`for`/`while`/`function`、**对象简写属性 `{ idx }`**（须写 `{ idx: idx }`）。

`src/nodes/code-node.ts` 的三条不可破坏的不变量：
1. **整批 vs 逐项由 `usesBuiltinItems(code)` 判定**：必须逐字符扫描——跳过字符串字面量、排除成员访问 `.items` 与对象键 `items:`、正确区分 `...` 展开与成员访问。
   曾用裸正则 `/\bitems\b|\$input\b/` → `json.items` / `{items:1}` / `'has items here'` 被误判整批 → **静默丢项**（N 输入只剩 1 项）。
2. **逐项模式返回语义**（`applyToItem`）：非空**数据项数组**（元素含 `json` 子对象）→ 展开多项（N 输入 × M 返回项 = N×M）；
   普通值数组 / 标量 / 普通对象 → 并入当前项 `output`；`undefined` / `null` → 透传当前项。
   **空数组 `[]` 不得判为数据项数组**：`[].every(f) === true`（vacuous truth），漏了 `result.length > 0` 守卫会把全部输入丢光且执行仍报 success。
3. **整批模式 `return []` → 0 项是正确语义**（n8n 行为），**不要**为此改 `normalizeBatchResult`；已由 `[QA-F3-guard]` 用例锁死。

求值失败必须 `throw`（`CodeEvaluationError` → 节点 failed → 执行 error）；**绝不能把错误写进 `output` 当数据**（曾用 `__codeError` 静默伪装成功）。

## REST 端点易错点
- `GET /rest/workflows/:id/executions/last-successful` 必须返回**完整** `executionDetail()`（含 `data.resultData.runData` + `workflowData`），
  否则前端 NDV 输入预览恒空。**端点级对账会漏检这类「端点通但功能不生效」缺陷**——必须配合实机载荷断言。
- 前端契约对账要走三层：①静态抽取 dist 调用 ②端点级探测（判据 = 兜底文案 `Not found: <METHOD> /rest/`）③真实浏览器/实机 E2E。

## 踩过的坑（改代码前必读）
1. **路由注册顺序**：`src/index.ts` 里 `/webhook*`、`/form*` 必须在 `app.get('*')` SPA fallback **之前**；`src/n8n/router.ts` 里所有具体路由必须在末尾 `.all('*')` 404 兜底**之前**。
   注意 SPA fallback 是 `app.get('*')`，**只拦 GET** —— 用 POST 探测路由顺序会漏检出问题。
2. **D1 迁移双写**：`CREATE TABLE IF NOT EXISTS` **不会**给已建库补列。改表必须同时改 `schema.sql` 与 `migrations/*.sql`，两条路径最终结构一致。`scripts/predeploy-check.mjs` 会校验。
3. **节点面板参数必须与执行器读取键对齐**：`src/plugins/builtin.ts` 里 `properties[].name` 必须等于执行器读的 `p.<key>`。
   - `fixedCollection` 型参数的 `p.x` 是**对象**（内层数组在 `p.x.x`），执行器不能直接当数组迭代。
   - `json` 型参数的值是**字符串**，需用 `src/nodes/common.ts` 的 `asJsonArray` / `asJsonRecord` 容错解析。
4. **禁止 `eval` / `new Function`**：Workers CSP 硬约束。
5. `def()` 是字段白名单工厂：加新字段（如 `credentials`）必须同步加进 `def()` 返回对象。
6. 节点元数据改动后需 `npm run gen:nodes` 重新生成 `frontend/dist/types/nodes.json`（生成物，**不要手改**）。
7. **安全判定不能依据客户端可控输入**：`request.url` 由 `Host` 头构造，据此判定「本地环境」可被伪造绕过。凭据/权限判定只读服务端配置（`env.*`）。
8. **`projectId` 语义**：个人项目统一为字符串 `'personal'`（`PERSONAL_PROJECT_ID` 于 `src/n8n/projects.ts`），历史 `NULL` 行由 `workflows.ts` 的 `normalizeProjectId` 读时归一。

## 团队协作纪律（Expert SoftwareCompany 多智能体）
- **作者 ≠ 验证者**：实现（`src/`）归工程师，测试（`tests/`）归 QA。**QA 不得改 `src/`** —— 自己写修复又自己验证等于自证。发现缺陷先回报，由主理人派单。
- **实机结论必须标注被测树状态**（HEAD sha / 是否含未提交改动）。`wrangler dev` 热重载工作树，**未提交的补丁会污染实测结论**（曾据此得出「无缺陷」的错误结论）。
- **所有临时产物只写 `.workbuddy/tmp/`**（建议分 `qa-rN/`、`engineer-rN/`），仓库根目录一律不落文件。
- **实现与测试分开 `git add`**，保持提交作者可分。
- **变异 / 反向验证串行执行**，避免并发互测互扰（会捕获到别人的变异窗口瞬时红）。
- 交付前过 `delivery-no-pseudoblock` 闸门（D1–D12 逐项枚举 + 贴快照）。

## Git 规范
- **禁止提交/推送到 main**；只用 `iter/YYYY-MM-DD` 分支；禁止 force push 与 `git reset --hard`。
- 提交前必须完成门禁验证并报告失败项；失败时不提交。
- `.workbuddy/` 已在 `.gitignore`。
