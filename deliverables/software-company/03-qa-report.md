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

---

# 第 2 轮回归验证（对 Engineer 修复 `f4f7fb1` 的独立复核）

- **被验提交**: `f4f7fb1`（fix(params): 修复节点参数与执行器读取键错配…并收口死控件），分支 `iter/2026-09-20`
- **验证原则**: 「证明它真的修好了」——用**独立复现脚本**直接驱动执行器，不依赖「套件转绿」自证
- **门禁**: `node scripts/run-tests.mjs` → **111/111 全绿**；`tsc --noEmit` → **零错误**；工作树对已跟踪文件干净

> **第 2 轮最终结论**：修复**真实且完整**，无回归，无「为迁就实现而放宽断言」。**最终路由判定 = NoOne（全部通过）**。

## R2.1 五个缺陷的独立复现（不走测试套件，直接驱动执行器）

脚本：`.workbuddy/tmp/round2-repro.ts` → **52/52 全 PASS**。

| 缺陷 | 复现输入 | 修复前 | 修复后实测 | 判定 |
| --- | --- | --- | --- | --- |
| **DEF-1** renameKeys | `{renaming:{renaming:[…]}}`(fixedCollection) | 抛 `TypeError: renames is not iterable` | 正常改名、不抛错 | ✅ |
| DEF-1 | `{renaming:[…]}`(旧形态) | 正常 | 正常（兼容保留） | ✅ |
| DEF-1 | `{renameKeys:[…]}`(旧形态) | 正常 | 正常（兼容保留） | ✅ |
| DEF-1 | 畸形 `renaming:'abc'` / `null` / `123` | —— | **不崩溃，安全降级（原样透传）** | ✅ |
| **DEF-2** aggregate.fields | json 字符串 `'[{field,aggregation}]'` | 输出 `[{}]` | `sum=30` 生效 | ✅ |
| DEF-2 | 已解析数组 | 生效 | 仍生效（**无回归**） | ✅ |
| DEF-2 | 非法 JSON `'{oops'` | —— | 不崩溃（安全降级） | ✅ |
| **DEF-3** editFields.fields | json 字符串 | 字段未写入 | `x=1` 生效 | ✅ |
| DEF-3 | 已解析数组 / 非法 JSON | —— | 仍生效 / 不崩溃 | ✅ |
| **DEF-4** assign.assignments | json 字符串 | 未赋值 | `y=9` 生效 | ✅ |
| DEF-4 | 已解析数组 / 非法 JSON | —— | 仍生效 / 不崩溃 | ✅ |
| **DEF-5** dateTime.additionalFields.add | json 字符串 `'{"value":1,"unit":"days"}'` | 未加 1 天 | `2020-01-01 → 2020-01-02` 生效 | ✅ |
| DEF-5 | 已解析对象 / 非法 JSON | —— | 仍生效 / 不崩溃 | ✅ |
| DEF-5(防御) | `additionalFields` 整体为字符串 | —— | 也可解析（+2 天） | ✅ |

**结论：5 个缺陷全部真实修复；已解析形态无回归；非法/畸形输入一律安全降级（不抛错、不 500）。**

## R2.2 新增工具函数边界审计（`src/nodes/common.ts` 的 `asJsonArray` / `asJsonRecord`）

| 输入 | `asJsonArray` 期望 | 实测 | `asJsonRecord` 期望 | 实测 |
| --- | --- | --- | --- | --- |
| `[1,2]` / `{a:1}` | 原样 | ✅ | 原样 | ✅ |
| `'[1,2]'` / `'{"a":1}'` | 解析 | ✅ | 解析 | ✅ |
| `''` / `'   '` | `null` | ✅ | `null` | ✅ |
| `'{oops'`（非法） | `null` | ✅ | `null` | ✅ |
| `null` / `undefined` | `null` | ✅ | `null` | ✅ |
| 标量 `'1'` / `'"s"'` / `'true'` / `'null'` | `null`（非数组） | ✅ | `null`（非对象） | ✅ |
| `'{"a":1}'` 传给 array / `'[1,2]'` 传给 record | 类型不匹配 → `null` | ✅ | 类型不匹配 → `null` | ✅ |
| 数字/普通对象/嵌套数组 `'[[1],[2]]'` | 非目标形态 `null` / 数组原样 | ✅ | `null` / 非对象 `null` | ✅ |

**语义符合预期：目标形态原样返回；字符串尝试解析；非法/空/标量/类型不匹配一律 `null`。** 无越界、无抛错。

## R2.3 三个死控件收口后的**行为回归**（重点）

- **L-1 `set.keepOnlySet`** ✅
  - `keepOnlySet:true` → 输出**仅含本节点写入字段**（丢弃上游 `a`、`x`）。
  - **默认（未设）与 `false` 行为完全一致，且等于修复前**（`{...输入, 写入}` 合并）——已用「复刻修复前合并逻辑」逐字段比对，**无回归**。
- **L-2 `respondWith`** ✅
  - 实机（8787）造 `responseMode='responseNode'` + `respondWith:'text'`（`webhook→Set(text="你好世界-hello")→respondToWebhook`）激活流：`POST /webhook/<path>` → **200、`Content-Type: text/plain; charset=utf-8`、体 = `你好世界-hello`（纯文本，非 JSON 包裹）**。
  - 对照 `respondWith` 缺省（json）流：→ **201（取 `responseCode`）、`Content-Type: application/json`**，回包体为节点输出 —— **与修复前一致，无回归**。
  - 单测层：`text` 模式返回 `{text: 首个输入项.text}`；默认/`json` 模式原样透传（与修复前逐字节相等）。
- **L-3 `DELETE /rest/tags/:id`** ✅
  - 不存在 id → **404**（与 `community-nodes/:name/uninstall` 语义统一）；存在 id → **200 `{data:true}`**。集成测试 + 实机双证据一致。

## R2.4 关于「工程师改了 1 条断言」的独立结论

变更：`tests/integration/rest-boundary.test.ts` 中，我方原用例把 `DELETE /rest/tags/<不存在>` **按现状锁定为 200**（并在注释中标注「与 community uninstall 的 404 语义不一致」）；工程师将其改为 **404**，并**新增**「删除存在的 id → 200」正例。

**判定：不构成「为迁就实现而放宽断言」，语义正确，属于合理的契约收紧（而非掩盖）。** 依据：

1. **与 n8n 原生行为一致**：n8n 的 `DELETE /rest/tags/:id` 对不存在的 tag 返回 **404（Tag not found）**；改断言为 404 是**向 n8n 契约对齐**，不是向 bug 妥协。
2. **实现同步修复**：`src/n8n/tags.ts` 确实新增了存在性校验（`SELECT id FROM tags WHERE id=?` → 无则 404）——**断言与实现同向收紧**。若只是「改断言、不修实现」，才叫掩盖；本例实现已改，测试描述的是新契约。
3. **我方原用例本就是「记录实际行为」而非「声明期望」**（原注释明写「记录实际行为」）。把「记录」升级为「声明目标契约」并同步统一语义，方向正确。
4. **新正例成立**：`DELETE 存在 id → 200 {data:true}` 实测通过，覆盖了收口后「存在即删」的正常路径，未被削弱。
5. 该变更由 team-lead 的「统一到 404」指令驱动，属产品决策，非测试自降标准。

> 补充：我方第 1 轮判定的缺陷从未被通过「改断言」掩盖——5 个 DEFECT 用例（A1–A5）在 `f4f7fb1` 中**保持原样未动**，靠修复实现转绿（见 R2.1），这正是「不迁就实现」的正确姿势。

## R2.5 第 2 轮反向验证（2 项注入，均已完整还原）

| 编号 | 注入 | 结果 | 还原 |
| --- | --- | --- | --- |
| **INJ-R2-1** | `src/nodes/util.ts` renameKeys 读键**回退**为 `p.renaming`（对象当数组迭代） | `node-param-alignment.test.ts` → **9/10，`[DEFECT-A5]` 转红** ✅ 捕获 | ✅ `git status` 干净 |
| **INJ-R2-2** | `src/nodes/common.ts` 的 `asJsonArray` 改为**恒返回入参（不解析）** | `node-param-alignment.test.ts` → **7/10，`[DEFECT-A1/A2/A3]` 转红** ✅ 捕获（A4 用 `asJsonRecord`、A5 内层已是数组，故不受影响，符合预期） | ✅ `git status` 干净 |

**两项注入均被新补齐的用例有效捕获，无「无效用例」。**

## R2.6 门禁与工作树

- `node scripts/run-tests.mjs` → **111 tests / 111 pass / 0 fail**。
- `tsc --noEmit` → **零错误**。
- 反向验证两项注入**全部还原**，`git diff --stat` 为空；`git status` 对源码/测试干净。
- 本轮唯一的工作树改动 = 本报告文件（`03-qa-report.md`）的**追加**（R2 章节），按要求保留。
- 未提交、未切分支、未推 main。

## R2.7 最终路由判定

### 判定：**NoOne（全部通过）**

- 5 个缺陷（DEF-1~5）与 3 个死控件收口（OBS-1~3）经**独立复现**确认修复有效，无回归、无新缺陷。
- 反向验证 2/2 项被新用例捕获。
- 门禁全绿（111/111、tsc 0）。
- 工程师对 `rest-boundary.test.ts` 的断言变更经复核为**合理收紧**，非掩盖。

**建议**：可进入阶段 5 交付汇总。

> 本轮新增脚本（不计入测试）：`.workbuddy/tmp/round2-repro.ts`、`qa-respondwith-e2e.mjs`。

---

# R3 第三轮增量：安全与确定性收口（SEC-1 / SEC-2 / SEC-3）

**触发**：R2 交付后遗留清单中的第 1、5 项属「可在部署前收口」的风险，本轮予以闭环：

1. `DEV_FALLBACK_PWD` 硬编码回退且**无启动期/请求期拦截** —— 公开默认口令即可登录 owner（P0）。
2. 同名 webhook path 命中多个已激活工作流时依赖隐式 rowid 顺序（不确定性）。

## R3.1 SEC-1：凭据守卫改为「生产默认拒绝」

**改动**：`src/n8n/auth.ts` 新增 `resolveCredentials(env)`，取代原先的 `env.X || DEV_FALLBACK` 无条件回退。

| 场景 | 收口前 | 收口后 |
| --- | --- | --- |
| 生产未配 Secret | 回退到 `mini-flow-demo-password` → **任何人可登 owner** | `/rest/login` **503** + 修复指引；受保护路由 **401** |
| 配置了弱凭据（口令<8 / 密钥<16） | 视为有效配置放行 | 视为「未配置」→ 503 |
| `ENVIRONMENT=development/dev/local` | — | 回退口令生效（本地调试路径保持可用） |
| 任意环境 + 伪造 `Host: localhost` | — | **无效**：判定只看环境变量，不读请求 Host |

**设计要点（防绕过）**：最初的实现草案以「请求是否来自回环地址」判定本地环境 —— 自审时发现
Cloudflare Workers 的 `request.url` 由 `Host` 头构造，攻击者伪造 `Host: localhost` 即可命中回退分支，
等于没修。改为**纯环境变量白名单**并**默认拒绝**（未显式声明开发环境即不启用回退），堵死该绕过路径。

配套：`Env` 增加 `ENVIRONMENT`；`.dev.vars.example`（示例）+ `.gitignore` 忽略 `.dev.vars`（防密钥入库）。

## R3.2 SEC-2：外部触发入口确定性选取

`matchWebhookWorkflow` / `matchFormWorkflow` 的查询补 `ORDER BY created_at ASC, rowid ASC`：
同名 path 命中多个已激活工作流时，**最早创建者胜出**；`created_at` 为秒级精度可能相等，以 `rowid` 稳定兜底。
消除了「改一条无关数据就可能让 webhook 换绑到另一个工作流」的隐性不确定性。

## R3.3 SEC-3：部署前自检门禁

新增 `scripts/predeploy-check.mjs`（挂 `predeploy`，`npm run deploy` 自动触发，失败即中止）：
结构绑定齐全性、Secret 显式确认（`MINI_FLOW_SECRETS_CONFIRMED=1`）、凭据守卫在位性、
`.dev.vars` 已被忽略、`migrations/*.sql` 与 `schema.sql` 的表集合一致性、关键扩展列在位。

**实跑结果**：`通过 10 / 警告 0 / 阻断 1`，唯一阻断项为 Secret 确认（预期行为，即本门禁要拦住的风险）。

## R3.4 新增用例与验证矩阵（18 例）

| 文件 | 用例数 | 覆盖 |
| --- | --- | --- |
| `tests/integration/auth-guard.test.ts` | 8 | 生产默认拒绝（503 / 无 Set-Cookie）、受保护路由 401、Host 伪造不可绕过、开发环境回退可用且会话有效、显式 production 即便本地也不回退、达标凭据正常登录 + 错口令 401、弱凭据按未配置处理、`resolveCredentials` 判定矩阵 |
| `tests/integration/webhook-determinism.test.ts` | 6 | 同名 path 取最早创建者（与插入顺序无关）、`created_at` 相同时 rowid 稳定兜底且可重复、active/test 模式互斥匹配、httpMethod 不匹配回落、form 入口确定性、path 归一化（首尾斜杠/编码）后仍命中 |
| `tests/integration/project-id.test.ts` | 4 | 历史 NULL 行归一化为 `personal` 且与 `/rest/projects` 一致、`projectId=personal` 过滤兼容 NULL 行、新建/导入/详情出参不为 null、`normalizeProjectId` 判定矩阵 |

## R3.5 反向验证（2 项注入，均已完整还原）

| 编号 | 注入 | 结果 | 还原 |
| --- | --- | --- | --- |
| **INJ-R3-1** | `auth.ts` 移除 `if (!DEV_ENVIRONMENTS.has(envName)) return null;`（即恢复「无条件下回退」） | `auth-guard.test.ts` → **3/8，5 例转红** ✅ 捕获（含核心断言「默认口令绝不能登入」） | ✅ 已还原，`tsc` 0 |
| **INJ-R3-2** | `webhook.ts` 移除 `ORDER BY created_at ASC, rowid ASC` | `webhook-determinism.test.ts` → **5/6，确定性用例转红**（实测返回 `w-late` 而非 `w-early`）✅ 捕获 | ✅ 已还原 |

> 说明：INJ-R3-1 中还暴露了一处**真实的自我缺陷** —— 编辑过程中 `auth.ts` 出现 3 处不一致
> （`checkLogin` 声明未同步、遗留 `pwdOf` 引用、`isAuthed` 传参数量错误），导致登录路径 **500**。
> 该问题由 `tsc --noEmit` + 用例（`200 !== 500`）当场拦截，未流出到提交。已完整修正。

## R3.6 门禁与工作树

- `node scripts/run-tests.mjs` → **129 tests / 129 pass / 0 fail**（R2 的 111 + SEC 14 + REQ-38 4）。
- `tsc --noEmit` → **零错误**。
- `node scripts/predeploy-check.mjs` → 10 通过 / 1 阻断（Secret 确认，属预期）。
- 反向验证 2 项注入**全部还原**；两处修复均经 `grep` 复核在位。

## R3.7 实机核验：REQ-37 / REQ-38 摘标签（并新增一处修复）

在本地 workerd（`wrangler dev` + 真实 D1 本地库，加载 `.dev.vars`）上以真实 HTTP 请求核验，
并对 `frontend/dist` 构建产物做静态溯源，把 PRD 中 4 项「未证实」中的 3 项摘掉标签：
其中 **1 项证伪并当场修复**（REQ-38）、**1 项证真闭环**（REQ-37）、1 项仍需浏览器（REQ-35/36）。

### REQ-38 —— 证实存在，已修复（P2 → 已闭环）

| 探测 | 收口前 | 收口后 |
| --- | --- | --- |
| `GET /rest/projects` | 个人项目 `id = "personal"` | 同 |
| `GET /rest/workflows` | `projectId: null`（**不一致**） | `projectId: "personal"` ✅ |
| `GET /rest/workflows?filter={"projectId":"personal"}` | 命中 **0** 条（历史行都是 NULL） | 命中 **6** 条 ✅ |

**影响**：前端「个人项目」视图按 projectId 过滤时，`null !== 'personal'` → 工作流列表为空。
属真实可见缺陷，而非「未证实」。

**修复**：`src/n8n/projects.ts` 导出唯一语义源 `PERSONAL_PROJECT_ID`；
`src/n8n/workflows.ts` 新增 `normalizeProjectId()`，在**所有 REST 出参**（列表 / `toResponse` 详情·导入·激活·归档·更新 / `/workflows/new`）与写入处归一化；
`projectId='personal'` 过滤时兼容历史 `NULL` 行（`project_id IS NULL OR project_id=?`）；
`src/n8n/executions.ts` 的执行列表过滤同步对齐。无数据迁移（读时归一 + 读旧行时顺带写回）。

新增 `tests/integration/project-id.test.ts`（4 例）锁定契约。

### REQ-37 —— 已闭环：确认无「幽灵条目」（附证据链）

`GET /rest/node-types` 返回 **68** 项，与内置节点数一致。是否会出现「可搜到可添加、但不在类型表」
的条目，取决于前端节点搜索的**数据来源**。对 `frontend/dist`（n8n editor-ui 构建产物）做静态溯源：

1. `NodeCreator-*.js` 的候选来源有两个：`useNodeTypesStore().nodeTypes`（来自 `/rest/node-types`）
   与 `communityNodesAndActions`。
2. `communityNodesAndActions` 在 nodeTypes store 中定义为
   `actionsGenerator.generateMergedNodesAndActions(unofficialCommunityNodeTypes.value, [])`，
   而 `unofficialCommunityNodeTypes` 是 `vettedCommunityNodeTypes` 过滤
   `!isOfficialNode && !isInstalled` 的结果 —— **即「未安装的社区节点建议列表」**。
3. `vettedCommunityNodeTypes` 由一次 `communityNodeTypes` 拉取填充，**catch 分支显式置为空 Map**
   （`vettedCommunityNodeTypes.value = new Map()`）。
4. 后端 `src/` 全库检索：**未实现** `/rest/community-node-types`
   （`grep -rn "community-node-types\|communityNodeTypes" src/` 命中 0），
   且未知 `/rest/*` 已收口为 404 JSON（REQ-22）。

结论：唯一可能产出「表外条目」的下拉来源在取数失败时降级为空 → 节点搜索的候选与
`/rest/node-types` **一致**，REQ-37 的目标达成，**无幽灵条目**。

**反方向的局限（如实记录，属 REQ-32 范围而非本项）**：通过 `POST /rest/community-nodes`
安装的社区包（如本地库中的 `n8n-nodes-e2e`，声明类型 `x.y`）出现在 `/rest/community-nodes`
与 `/rest/plugins`（设置页可见），但其声明类型**不会进入节点面板**，即「装了但搜不到」。
这与 REQ-37 描述的「搜到但不存在」是相反方向，二者不会同时成立。

### REQ-35 / REQ-36 —— 仍未证实

均为纯前端渲染（版本横幅文案、NDV 头部与执行步骤按钮），需真实浏览器会话观察，
本轮以 REST/HTTP 层核验无法覆盖，保留「未证实」。

## R3.8 门禁与工作树（含 REQ-38 后）

- `node scripts/run-tests.mjs` → **129 tests / 129 pass / 0 fail**（R2 的 111 + SEC 14 + REQ-38 4）。
- `tsc --noEmit` → **零错误**。
- 反向验证 3 项注入（INJ-R3-1/2/3）**全部被捕获并完整还原**：

| 编号 | 注入 | 结果 |
| --- | --- | --- |
| INJ-R3-1 | 移除凭据守卫的环境白名单判定 | `auth-guard` 5/8，核心断言「默认口令绝不能登入」转红 ✅ |
| INJ-R3-2 | 移除 webhook 查询的 `ORDER BY` | 确定性用例转红（实测返回 `w-late`）✅ |
| INJ-R3-3 | `toResponse` 回退为 `wf.projectId ?? null` | project-id 用例转红（`null !== 'personal'`）✅ |

- 实机实证（真实 workerd 运行时，非仅测试夹具）：

| 场景 | 实测 |
| --- | --- |
| 无 `.dev.vars` → 默认口令 `POST /rest/login` | **503** + 修复指引，无 `Set-Cookie` |
| 同上 + 伪造 `Host: localhost` | **503**（不可绕过） |
| 无 `.dev.vars` → `GET /rest/workflows` | **401** |
| 有 `.dev.vars` → 本地口令登录 | **200**，会话可访问 `/rest/workflows`、`/rest/owner` = **200** |
| 有 `.dev.vars` → 旧硬编码默认口令 | **401**（已失效） |
| `projectId` 归一化 | `null` → `"personal"`；filter 命中 0 → **6** |

- 本地 `.dev.vars` 已创建（gitignore 生效，`git status` 不出现）；`scripts/predeploy-check.mjs` 实跑
  `通过 10 / 阻断 1`（Secret 确认，属门禁应拦项）。

## R3.9 本轮最终判定

**判定：通过（含 1 项新发现并当场修复）。**

**仍未闭环（需运维/后续决策）**：

1. **线上实例仍运行旧代码**，本轮修复（含 P0 凭据守卫、REQ-38）**尚未部署**。
   部署前必须：`wrangler secret put ADMIN_PASSWORD` / `wrangler secret put SESSION_SECRET`
   → 再 `MINI_FLOW_SECRETS_CONFIRMED=1 npm run deploy`。
   ⚠️ 未配置 Secret 直接部署，实例会「失败关闭」（登录 503），这是**有意的安全取舍**而非故障。
2. **REQ-37 已闭环**（无幽灵条目，证据链见 R3.7）；其反方向局限「已安装社区节点的声明类型
   不进节点面板」属 REQ-32 范围，建议独立增量处理。
3. REQ-35 / REQ-36 仍需浏览器实机复测。
4. 凭据落库仍为 KV 明文（出站已脱敏），未做静态加密。
5. 节点数量保持 68，未向 n8n 400+ 扩容。


