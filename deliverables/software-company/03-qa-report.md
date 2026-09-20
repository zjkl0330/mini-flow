# QA 验证报告 —— mini-flow 增量交付（iter/2026-09-20）

- **验证人**: 严过关（软件测试工程师 / QA）
- **被验提交**: `8f0d654`（增量）、`e0681b8`（基线修复）、`30c2af1`（文档）
- **分支**: `iter/2026-09-20`（工作树验证前干净）
- **工具链**: Node `22.22.2-3`（`node:sqlite` 真实 D1 垫片）；`node scripts/run-tests.mjs`；`tsc --noEmit`
- **实机环境**: `http://127.0.0.1:8787`（wrangler dev + 本地 D1，已跑 `migrations/increment-01.sql`）
- **验证方式**: 对抗性独立复核（不采信工程师自述）+ 反向注入验证 + 实机端到端

---

## 0. 结论摘要（先给判定）

| 项 | 结果 |
| --- | --- |
| 测试总结 | 基线 **77/77 通过** → 新增 34 例后 **111 例：106 通过 / 5 失败**（失败均为**真实源码缺陷**，非测试问题） |
| 反向验证（A） | 4 项注入 **其中 3 项被现有套件直接捕获**；**第 2 项（webhook 注册顺序）现有套件漏检** → 已修复测试并复验捕获 |
| 实机复核（B/F） | webhook 边界、form、responseNode 回包、迁移一致性 **全部通过** |
| 缺陷 | **共 5 条真实功能缺陷**（1 高 + 4 中），另有 2 条低severity一致性观察；工程师自报的 4 处「疑点」**全部证实为真缺陷**，并**新发现 1 处崩溃级缺陷（renameKeys）** |
| 路由判定 | **Engineer（源码有 bug，需回修）** |

---

## 1. 测试总结

### 1.1 新增测试文件（均在 `tests/`，未改动任何 `src/` 业务代码）

| 文件 | 用例数 | 目的 |
| --- | --- | --- |
| `tests/integration/app-wiring.test.ts` | 5 | 装配**真实** `src/index.ts`，锁定 `/webhook`、`/form` 必须早于 SPA fallback（补 A2 漏检缺口） |
| `tests/integration/webhook-boundary.test.ts` | 9 | Webhook/Form 对抗性边界（路径归一化/方法/active-test/disabled/同名/中文二进制/responseMode） |
| `tests/integration/rest-boundary.test.ts` | 8 | retry/export/import/tags/community/insights 异常路径（404/400，均不得 500） |
| `tests/integration/schema-migration.test.ts` | 2 | `schema.sql`（新库）与 `旧schema+increment-01.sql`（升级库）结构一致性 |
| `tests/unit/node-param-alignment.test.ts` | 10 | REQ-16 参数↔执行器读取键对齐审计（5 通过 + 5 失败=缺陷证据） |
| `tests/helpers/cf-loader.mjs`、`tests/helpers/cf-workers-stub.mjs` | — | 测试专用 ESM loader，把 `cloudflare:workers` 重定向到桩，使真实 `index.ts` 可被测试装配 |

> 合计新增 **34 例**：**29 通过 / 5 失败**。基线 77 + 34 = **111 例**。

### 1.2 现存套件的覆盖盲点（本次修复）

`tests/integration/webhook.test.ts` **自己复刻了 `makeApp()`**（内置正确的注册顺序），因此它**根本无法发现 `src/index.ts` 里 `/webhook` 被挪到 SPA fallback 之后**（见 §2-INJ-2）。已通过 `app-wiring.test.ts` 直装真实入口补齐该缺口，并额外发现 **SPA fallback 是 `app.get('*')`（仅 GET）**，故测试同时覆盖 GET（会被抢先）与 POST（不会）两类方法。

### 1.3 类型检查

`tsc --noEmit` → **零错误**（`tsconfig.json` 仅 include `src`，新增测试不影响）。

---

## 2. A 反向验证逐项结果（最重要）

方法：用 `Edit` 注入缺陷 → 跑 `run-tests.mjs` → 记录失败 → `git checkout --` 还原 → 复跑确认恢复。**每项注入后 `git status` 均确认工作树还原为干净**。

| 编号 | 注入内容 | 注入后失败数 | 是否被捕获 | 还原后 |
| --- | --- | --- | --- | --- |
| **INJ-1** | `src/n8n/router.ts` 的 `OPEN_PATHS` 加入 `/workflows`（破坏鉴权墙） | **2 失败**：`未登录：所有受保护端点一律 401`、`未登录不得写入…401` | ✅ 捕获 | ✅ 恢复 77/77 |
| **INJ-2** | `src/index.ts` 把 `/webhook/*`、`/form/*` 移到 `app.get('*')` 之后 | **首次：0 失败（77/77）→ 现有套件漏检** ❌；补测后：**3 失败**（`/webhook` GET、`/form`、`/webhook-test`） | ⚠️ 首测漏检 → **已修复测试**后捕获 | ✅ 恢复 |
| **INJ-3** | `src/plugins/builtin.ts` 把 `outputNode` 的 `properties` 清空为 `[]` | **1 失败**：`REQ-16/17：节点 properties 全部非空…` | ✅ 捕获 | ✅ 恢复 |
| **INJ-4** | `src/nodes/http-request.ts` 把非 2xx 判断改回「不抛错」（`if (false && …)`） | **1 失败**：`HTTP 节点：非 2xx 默认抛错` | ✅ 捕获 | ✅ 恢复 |

### 2.1 关键发现：INJ-2 现有套件无效，已修测试

- **问题**：`webhook.test.ts` 不导入真实 `src/index.ts`，而是自建 `Hono` app 并手工按正确顺序注册。因此**无论 `index.ts` 怎么改，该测试都通过**——它验证的是「测试自己写的顺序」，不是「产品的顺序」。
- **修复**：新增 `tests/integration/app-wiring.test.ts`，通过测试专用 loader（`tests/helpers/cf-loader.mjs`）把 `cloudflare:workers` 重定向到桩，从而 `import worker from '../../src/index'` 并对真实 `worker.fetch` 发请求。修复后 INJ-2 **稳定触发 3 条失败**。
- **附带发现**：SPA fallback 是 `app.get('*')`，**只拦 GET**。若仅用 POST 探测 `/webhook/<不存在>`，即使注册顺序写错也**不会**被 fallback 抢先（POST 会穿透到后注册的 `app.all('/webhook/*')`）。故测试**必须同时覆盖 GET**——这正是首版补测只捕获到 `/form`（GET）的原因，随后补上 GET 用例才全覆盖。

> **结论**：反向验证发现并修复了 1 处「无效用例」（INJ-2），其余 3 项注入均被现有套件有效捕获。还原后基线恢复 **77/77**（加入新测试后为 106/111，失败项均为下方真实缺陷）。

---

## 3. B Webhook 对抗性边界（集成测试 + 实机）

| 边界 | 实测行为 | 判定 |
| --- | --- | --- |
| `/webhook/e2e-hook/`（尾斜杠） | 200 命中（归一化去尾斜杠） | ✅ 合理 |
| `/webhook//e2e-hook`（双斜杠） | 200 命中（归一化去前导斜杠） | ✅ 合理（宽松） |
| `/webhook/E2E-HOOK`（大小写） | **404**（大小写敏感） | ✅ 与 n8n 一致 |
| `/webhook/e2e%2Dhook`（URL 编码） | 200 命中（先 `decodeURIComponent` 再比） | ✅ 合理 |
| `httpMethod` 不匹配（节点 POST，请求 GET） | **404，不触发** | ✅ 正确 |
| `/webhook-test/<active=1 path>` | **404**（不触发） | ✅ 符合「test 仅对 active=0」 |
| `/webhook-test/<active=0 path>` / `/webhook/<active=0>` | 分别 **200 / 404** | ✅ 双向隔离正确 |
| webhook 节点 `disabled:true` | **404（跳过）** | ✅ 正确 |
| 同名 path 在多个已激活工作流 | **只触发 1 条**，取 `SELECT … WHERE active=1` 的 rowid 首条（首插者） | ⚠️ 行为确定但**依赖 rowid 顺序**（无 ORDER BY）；已如实记录 |
| JSON body 含中文 / `application/octet-stream` 二进制 | 200；中文原样进 `executions.input_data`，二进制不当机 | ✅ 不丢数据、不 500 |
| **`responseMode:'responseNode'`**（实机 8787） | 造 `webhook → respondToWebhook(responseCode:202)` 激活流，`POST /webhook/<path>` → **HTTP 202**，回包为该节点输出（`{body,headers,query,params,method}`），**非** `{"message":"Workflow was started"}` 占位；执行落库 `status=success, mode=webhook` | ✅ **未走 30s 超时回落**，真实回包正确 |
| `responseMode:'onReceived'`（显式） | 立即 200 started（不进等待） | ✅ 正确 |
| 未注册 webhook 404 体 | `{code:404,message:'The requested webhook "..." is not registered.'}` + `application/json` | ✅ 符合契约 |

结论：webhook/form/responseMode 的对抗性边界**行为正确、无缺陷**。

---

## 4. C 工程师自报「遗留疑点」独立核验（证实/证伪）

工程师称：`aggregate.selection=fields`、`editFields.fields`、`assign.assignments`、`dateTime.additionalFields.add` 用 `json` 型（值=字符串），而执行器期望**数组**，因此「面板能填但不生效」。**实测复现（直接驱动执行器，喂编辑器真实写入形态）：**

| 节点 | 面板填写（json 字符串） | 执行器实际行为 | 结论 |
| --- | --- | --- | --- |
| `aggregate` | `fields='[{"field":"b","aggregation":"sum"}]'` | 输出 `[{}]`（未聚合；传数组才得 `b:30`） | **真缺陷（证实）** |
| `editFields` | `fields='[{"name":"x","value":"1"}]'` | 字段 `x` **未写入**（传数组才写入） | **真缺陷（证实）** |
| `assign` | `assignments='[{"name":"y","value":9}]'` | 字段 `y` **未赋值**（传数组才赋值） | **真缺陷（证实）** |
| `dateTime` | `additionalFields.add='{"value":1,"unit":"days"}'` | 日期**未 +1 天**（传对象才 +1 天） | **真缺陷（证实）** |

工程师为规避该问题而改用 `fixedCollection` 的 `set` / `sort` / `removeDuplicates` 三处，**读取键确与执行器对齐**（已实测通过）：

- `set`：`p.assignments.assignments` ✅
- `sort`：`p.rules.rules` ✅
- `removeDuplicates`：`p.options.pairing.pairing` ✅

> **新发现（工程师未提及）**：`renameKeys` 也改成了 `fixedCollection`，但执行器仍按数组读 `p.renaming`，导致 **`THROW: renames is not iterable`** —— 这是比上述 4 条更严重的**崩溃级缺陷**（详见 §8 DEF-1）。

---

## 5. D 参数名 ↔ 执行器读取键 全量对齐审计（§6 的 33 节点）

图例：✅ 对齐；❌ 缺陷；⚠️ 轻微/占位（不影响主流程）。执行器来源见 `src/nodes/*.ts`。

| 节点 | 属性 name | 执行器读取键 | 对齐 |
| --- | --- | --- | --- |
| switch | mode / rules | `p.mode` / `p.rules.values` | ✅ |
| set | assignments / keepOnlySet | `p.assignments.assignments` / **未读取** | ✅ / ⚠️ keepOnlySet 无效(执行器始终 merge) |
| merge | mode | `p.mode` | ✅ |
| splitInBatches | batchSize | `p.batchSize` | ✅ |
| delay | amount / unit | `p.amount` / `p.unit` | ✅ |
| outputNode | outputs | `p.outputs` | ✅ |
| removeDuplicates | options | `p.options.pairing.pairing` | ✅ |
| filter | conditions / combinator | `p.conditions.conditions` / `p.combinator` | ✅ |
| sort | rules | `p.rules.rules` | ✅ |
| **aggregate** | **fields(json)** | `p.fields`（期望数组） | ❌ **DEF-2** |
| math | expression | `p.expression` | ✅ |
| **dateTime** | dateProperty / **additionalFields.add(json)** | `p.dateProperty` / `p.additionalFields.add`（期望对象） | ✅ / ❌ **DEF-5** |
| extractFromFile | sourceKey | `p.sourceKey` | ✅ |
| **editFields** | mode / **fields(json)** | `p.mode` / `p.fields`（期望数组） | ✅ / ❌ **DEF-3** |
| **renameKeys** | **renaming(fixedCollection)** | `p.renaming`（按数组迭代） | ❌ **DEF-1（崩溃）** |
| **assign** | **assignments(json)** | `p.assignments`（期望数组） | ❌ **DEF-4** |
| textSplitter | text / chunkSize / chunkOverlap | `p.text` / `p.chunkSize` / `p.chunkOverlap` | ✅ |
| textCase | field / action | `p.field` / `p.action` | ✅ |
| textCount | field | `p.field` | ✅ |
| formTrigger | path / formTitle / formFields(json) | `parameters.path` / `p.formTitle` / `p.formFields`（`parseFormFields` 会 `JSON.parse`） | ✅ |
| intervalTrigger | minutesInterval | `p.minutesInterval`（scheduler.ts） | ✅ |
| respondToWebhook | respondWith / responseCode | **未读取** / `parameters.responseCode`（webhook.ts） | ⚠️ respondWith 无效 / ✅ responseCode |
| function | code | `p.code`（code-node `sourceOf`） | ✅ |
| mySql / postgres | connection + notice | 占位（`dbPlaceholderNode` 读 `p.operation`） | ⚠️ 占位设计 |
| sqlite | query | `p.query`（d1QueryNode） | ✅ |
| embeddings / huggingFace | model / apiKey | 占位（`aiPlaceholderNode`） | ⚠️ 占位设计 |
| sendgrid / email / slack / telegram / discord | to/from/subject/text… | 占位（`notifyPlaceholderNode`） | ⚠️ 占位设计 |

**不对齐（真缺陷）共 5 处**：aggregate、dateTime、editFields、renameKeys、assign。其余 ⚠️ 为轻微一致性或占位设计，不阻断主流程。

---

## 6. E REST 端点边界（集成测试 + 实机 8787 双证据）

| 用例 | 预期 | 实测（集成/实机一致） | 判定 |
| --- | --- | --- | --- |
| `POST /rest/executions/<不存在>/retry` | 404 | **404** `Execution not found` | ✅（非 500） |
| 执行存在但 workflow 缺失时 retry | 404 | **404** `Workflow not found` | ✅（非 500） |
| retry 已 `completed` 执行 | 允许重跑 | **200**，新 execution `retryOf=原id` | ✅ |
| `GET /rest/workflows/<不存在>/export` | 404 | **404** | ✅ |
| export 文件名特殊字符 | 安全化 | `filename="a_b_c_.json"` | ✅ 防注入 |
| `POST /rest/workflows/import` 已存在 id | 重新分配 UUID | **201**，新 UUID，**原流未被覆盖** | ✅ |
| import 空 body / 非法 JSON / 字面量 `null` | 4xx | **400**（三者均非 500） | ✅ |
| `POST /rest/tags` 空 name | 400 | **400** | ✅ |
| `PATCH /rest/tags/<不存在>` | 404 | **404** | ✅ |
| `PATCH /rest/tags/:id` 空 name | 400 | **400** | ✅ |
| `DELETE /rest/tags/<不存在>` | 记录实际 | **200 `{data:true}`**（幂等删除，**不校验存在性**） | ⚠️ 与 community uninstall 的 404 语义**不一致**（低） |
| `POST /rest/community-nodes` 空 name / 重复 | 400 / 409 | **400 / 409** | ✅ |
| `POST /rest/community-nodes/<不存在>/uninstall` | 404 | **404** | ✅ |
| `GET /rest/insights/summary?startDate=abc&endDate=xxx` | 不 500 | **200**（回落默认聚合） | ✅ |
| 未知 `/rest/*`（回归 REQ-22） | 404 JSON | **404 JSON** | ✅ |
| 匿名 `/rest/workflows`、`/rest/credentials` | 401 | **401** | ✅ |

---

## 7. F 迁移正确性（新库 vs 升级库一致性）

方法（`tests/integration/schema-migration.test.ts`，用 `node:sqlite` 建两个内存库）：

- 路径 A（新库）：直接执行 `schema.sql`。
- 路径 B（升级库）：执行**改动前**基线 schema（`git show 31dec73:schema.sql`）+ `migrations/increment-01.sql`。
- 对比：`sqlite_master` 表集合、`PRAGMA table_info(executions)`（名称+类型+notnull+默认值）、索引集合。

**结果：两条路径最终结构完全一致** ✅

- 表：均含 `tags`、`workflow_tags`、`community_nodes`。
- `executions` 列：均含 `retry_of`、`retry_success_id`，列定义逐项相等。
- 索引：均含 `idx_executions_retry_of`、`idx_workflow_tags_tag`。
- 实际读写：升级库中新列可正常 INSERT/SELECT。

> 注：`migrations/increment-01.sql` 的 `ALTER TABLE ADD COLUMN` 无 `IF NOT EXISTS`，重复执行会报 "duplicate column name" —— 文件头已明示「对已建库一次性执行」，属预期，非缺陷。

---

## 8. 缺陷清单

| 编号 | 严重级 | 模块 | 预期 vs 实际 | 复现步骤 | 证据 |
| --- | --- | --- | --- | --- | --- |
| **DEF-1** | **高** | `src/nodes/util.ts::renameKeysNode` + `src/plugins/builtin.ts` | 预期：面板填 fixedCollection `renaming` 后按 from→to 改名；实际：**执行器抛 `TypeError: renames is not iterable`**（把对象 `{renaming:[…]}` 当数组迭代）→ 节点失败 | 驱动 `renameKeysNode.execute`，参数 `{renaming:{renaming:[{fromKey:'a',toKey:'z'}]}}` | `tests/unit/node-param-alignment.test.ts` `[DEFECT-A5]`；独立复现输出 `THROW renames is not iterable`。**修法建议**：读 `p.renaming?.renaming ?? p.renameKeys` |
| **DEF-2** | 中 | `src/nodes/transform.ts::aggregateNode` + builtin `aggregate.fields` | 预期：json 型 `fields` 生效；实际：字符串 `'[…]'` 非数组 → 回落 `[]` → 输出 `[{}]`，**聚合失效** | 参数 `fields:'[{"field":"b","aggregation":"sum"}]'`，输入 `[{b:10},{b:20}]` → 实际 `[{}]` | `[DEFECT-A1]`；复现脚本输出 `aggregate(json-string)-> [{"json":{}}]` |
| **DEF-3** | 中 | `src/nodes/transform.ts::editFieldsNode` + builtin `editFields.fields` | 预期：json 型 `fields` 写入字段；实际：`for…of` 遍历字符串（逐字符，无 `name`）→ **静默不生效** | 参数 `fields:'[{"name":"x","value":"1"}]'` → 输出无 `x` | `[DEFECT-A2]` |
| **DEF-4** | 中 | `src/nodes/util.ts::assignNode` + builtin `assign.assignments` | 预期：json 型 `assignments` 赋值；实际：遍历字符串 → **静默不生效** | 参数 `assignments:'[{"name":"y","value":9}]'` → 输出无 `y` | `[DEFECT-A3]` |
| **DEF-5** | 中 | `src/nodes/transform.ts::dateTimeNode` + builtin `dateTime.additionalFields.add` | 预期：json 型 `add` 做日期加减；实际：`addT` 为字符串 → `addT.value` undefined → **不做加减** | 参数 `additionalFields.add:'{"value":1,"unit":"days"}'`，基线 2020-01-01 → 实际仍 2020-01-01（应 2020-01-02） | `[DEFECT-A4]` |
| **OBS-1** | 低 | `src/nodes/if-condition.ts::setNode` + builtin `set.keepOnlySet` | `keepOnlySet` 属性声明了但执行器从不读取（始终 merge），面板开关**无效果** | 设 `keepOnlySet:true`，输出仍保留原字段 | `tests/unit/node-param-alignment.test.ts` 对齐组（set 用例观察） |
| **OBS-2** | 低 | `src/nodes/logic.ts::respondToWebhookNode` + builtin `respondToWebhook.respondWith` | `respondWith` 属性声明了但执行器忽略（回包由 webhook.ts 按 `responseCode` 处理，`respondWith` 不影响内容） | 设 `respondWith:'text'`，回包仍为 JSON | §5 审计表；§3 实机 responseNode 证据 |
| **OBS-3** | 低 | `src/n8n/tags.ts::DELETE /:id` | `DELETE /rest/tags/<不存在>` 返回 **200 `{data:true}`**（不校验存在性），与 `community-nodes/:name/uninstall` 的 **404** 语义不一致 | `DELETE /rest/tags/nope-xyz` → 200 | §6 表；实机探测输出 |

> **未计为缺陷**：mySql/postgres/embeddings/huggingFace/sendgrid/email/slack/telegram/discord 的参数「不生效」属**设计明示的占位语义**（设计 §1 REQ-17、§7），本轮只做元数据闭环，不算缺陷。

### 缺陷最小复现（可直接跑）

```bash
cd F:/Documents/GitHub/mini-flow
# DEF-1~DEF-5 一次性复现（含编辑器真实参数形态）
node --import tsx --disable-warning=ExperimentalWarning .workbuddy/tmp/repro-params.ts
node --import tsx --disable-warning=ExperimentalWarning .workbuddy/tmp/repro-params2.ts
# 以测试断言形式复现（当前 5 例红）
node --import tsx --test tests/unit/node-param-alignment.test.ts
```

---

## 9. 智能路由判定

### 判定：**Engineer（源码有 bug，需回修）**

**理由**：新增的 `tests/unit/node-param-alignment.test.ts` 5 条断言**期望正确行为（与设计 §5 第 7 条「参数名必须与执行器读取键对齐」一致）却失败**，且失败原因在**源码**而非测试：

- 断言「json 型参数经面板写入后应生效」——符合设计意图（面板可配即应生效）→ 实际 `aggregate/editFields/assign/dateTime` 静默失效。
- 断言「renameKeys 的 fixedCollection 应被正确读取、不抛错」——符合设计意图 → 实际抛 `TypeError`。

按 QA 路由规则：**断言正确、源码错误 → 路由 Engineer**。测试代码本身无误（无「测试写错」项，故不走 QA 自修路径）。

**给 Engineer 的最小修复建议（择一，勿改测试断言）**：
1. 对 DEF-2~DEF-5：在 4 个执行器里对 `json` 型参数做 `JSON.parse` 容错（字符串则解析），或把 `builtin.ts` 中这 4 个属性改为 `fixedCollection`（与 set/sort 一致）。
2. 对 DEF-1：`renameKeysNode` 读取键改为 `p.renaming?.renaming ?? p.renameKeys ?? []`（并加 `Array.isArray` 守卫）。
3. 修复后本轮已备好的回归用例（`node-param-alignment.test.ts` 的 A1–A5）应转绿。

**复核口径**：Engineer 修复并提交后，重跑 `node scripts/run-tests.mjs` 应以 **111/111** 通过为准。

---

## 附：交付物与工作树状态

- 新增测试：`tests/integration/app-wiring.test.ts`、`webhook-boundary.test.ts`、`rest-boundary.test.ts`、`schema-migration.test.ts`；`tests/unit/node-param-alignment.test.ts`；`tests/helpers/cf-loader.mjs`、`cf-workers-stub.mjs`。
- **未改动任何 `src/` 业务代码**；反向验证注入**已全部还原**，`git diff --stat` 为空（工作树对已跟踪文件干净）。
- 辅助脚本（不计入测试）：`.workbuddy/tmp/repro-params.ts`、`repro-params2.ts`、`qa-webhook-e2e.mjs`、`qa-rest-probe.mjs`。
