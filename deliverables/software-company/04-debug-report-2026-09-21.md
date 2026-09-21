# Debug 交付与独立验证报告 —— mini-flow 缺陷收敛轮（iter/2026-09-21）

- **执行模式**: Agent 模式 + Expert「SoftwareCompany」团队 SOP（主理人 / 软件工程师 / 软件测试工程师）
- **分支**: `iter/2026-09-21`（工作树验证前、验证后均为干净）
- **工具链**: Node `22.22.2-3`；`node scripts/run-tests.mjs`（`node:test` + `tsx` + `node:sqlite` 真实 D1 垫片）；`tsc --noEmit`
- **实机环境**: `http://127.0.0.1:8787`（`wrangler dev` + 本地 D1），凭据来自 `.dev.vars`
- **验证方式**: 三层对账（静态抽取 / 端点级探测 / 真实浏览器·实机 E2E）+ 对抗性独立复核（不采信工程师自述）+ 反向注入验证
- **日期**: 2026-09-21

---

## 0. 结论摘要

| 项 | 结果 |
| --- | --- |
| 缺陷（本轮新增收敛） | **6 条**：2 条 P0（静默失败 / 载荷不足）、1 条 P0 回归（静默丢项）、1 条语义缺失、1 条可用性、1 条低危边缘（空真丢项） |
| 门禁 | `tsc --noEmit` **0 错误**；`scripts/run-tests.mjs` **208/208 全绿** |
| 反向验证 | 4 个变异点，**全部精确命中**预期用例（详见 §4） |
| 实机 E2E | 12/12 边界场景通过（§5）；P0-2 载荷契约双场景通过 |
| 遗留 | 无未闭环缺陷；受限求值器能力边界为既定设计（§7） |
| 终判 | **NoOne（全部闭环）** —— 无待派单项 |

---

## 1. 缺陷清单与修复提交

| # | 严重度 | 缺陷 | 根因 | 修复提交 |
| --- | --- | --- | --- | --- |
| D1 | **P0** | Code 节点求值失败**静默伪装成功**：错误被写进 `output` 当数据，节点 `completed`、执行 `success`，下游拿到污染数据 | `src/nodes/code-node.ts` 存在 `__codeError` 静默回写路径，未抛错 | `c069a1e` |
| D2 | **P0** | `GET /rest/workflows/:id/executions/last-successful` 载荷不足，前端 NDV 预览**恒空** | 端点只返回执行摘要，缺 `data.resultData.runData` 与 `workflowData`（端点级对账无法发现「端点通但功能不生效」） | `7f84630` |
| F1 | **P0** | 内置 `items` 引用判定**过宽**导致静默丢项：`json.items` / `{ items: 1 }` / `'has items here'` 被误判为整批模式，N 个输入只保留 1 项 | 判定用裸正则 `/\bitems\b\|\$input\b/`，不区分成员访问、对象键、字符串字面量 | `06e33d2` |
| F2 | 中 | 逐项模式返回**数据项数组**（`[{ json: … }]`）未展开为多项，N 个输入只出 1 项 | `applyToItem` 返回单 Item，未做 `flatMap` 展开 | `399edff` |
| F2b | 低 | 对象简写属性 `{ idx }` 报错「对象缺少冒号」，**无可行指引** | 受限求值器（禁 `eval`）不支持简写，但错误文案未给出正确写法 | `399edff` |
| F3 | 低 | 逐项模式返回空数组 `[]` 时**丢光全部输入项**，执行仍报 `success` | `[].every(isItemShape)` 恒为 `true`（vacuous truth）→ 误判为数据项数组 → 展开为 0 项 | `7cc5c2c` |

### 修复要点

- **D1**（`src/nodes/code-node.ts`、`src/engine/evaluator.ts`、`src/types.ts`）：移除 `__codeError` 静默路径，新增 `CodeEvaluationError`，求值失败一律 `throw`；补齐 n8n 输入语义（`items` / `$input.all()|first()|last()` / `$json` / `$now` / `env`）。
- **D2**（`src/n8n/workflows.ts`、`src/n8n/executions.ts`）：last-successful 改返回完整 `executionDetail()`（含 `data.resultData.runData` + `workflowData`），删除死函数 `toExecutionSummary`。
- **F1**：新增 `usesBuiltinItems(code)` 逐字符扫描——跳过字符串字面量、排除成员访问 `.items` 与对象键 `items:`、正确处理 `...` 展开运算符。
- **F2**：`applyToItem` 返回 `Item[]`，`execute` 改用 `inputs.flatMap(...)`；数组结果按 `isItemShape`（含 `json` 子对象）展开为多项，普通值数组维持「并入 `output`」的历史语义。
- **F2b**：`CodeEvaluationError` 文案追加「注意：不支持对象简写属性（如 `{ idx }`），请写成 `{ idx: idx }`。」
- **F3**：`if (result.length > 0 && result.every(isItemShape))`，空数组回到「普通值数组」分支。**整批模式未改动**——整批模式 `return []` → 0 项是 n8n 正确语义。

---

## 2. 提交链（`iter/2026-09-21`）

```
95f266e  test(qa): 锁死 F3 逆向护栏——整批 return [] 语义与逐项输出数恒等输入数
f496b6a  test(qa): 补 F3 回归——逐项模式 return [] 不丢项
7cc5c2c  fix(code): 逐项模式空数组 [] 不再被 every 误判为数据项数组而丢项（QA F3）
a1224a9  test(qa): Round2 独立复验——F1 修复 + 数据项数组展开语义
399edff  fix(code): 逐项模式返回数据项数组时展开为多项 + 提示不支持对象简写属性（派单第4/5项）
06e33d2  fix(code): 修正内置 items 引用判定过宽导致的静默丢项（QA F1）
ba798fc  test(qa): 独立对抗性回归——Code 节点显式失败/items 语义 + last-successful 载荷契约
7f84630  fix(rest): last-successful 返回完整执行详情，前端 NDV 预览不再恒空
c069a1e  fix(code): Code 节点求值失败不再静默伪装成功 + 补齐 n8n 输入语义
```

作者分离：实现（`src/`）= 工程师；测试（`tests/`）= QA。唯一例外见 §6-3。

---

## 3. 用例演进

| 时点 | 用例数 | 来源 |
| --- | --- | --- |
| 本轮起点（项目基线，2026-09-20 记录） | 129 | 项目记忆 |
| D1/D2 + QA 对抗性用例提交后（`ba798fc`） | 188 | 实测 |
| 叠加 QA 未提交的对抗性用例（现 `a1224a9` 内容） | 204 | 实测 |
| QA Round 2 提交（`a1224a9`） | 204 | 实测 |
| 工程师 F3 用例（`7cc5c2c`，+1） | 205 | 实测 |
| QA F3 用例（`f496b6a`，+1） | 206 | 实测 |
| QA F3 逆向护栏（`95f266e`，+2） | **208** | 实测 |

---

## 4. 反向验证矩阵（注入缺陷 → 必须精确转红）

| 变异点 | 预期精确转红 | 实测 | 执行者 |
| --- | --- | --- | --- |
| `usesBuiltinItems` 换回旧宽正则 `/\bitems\b\|\$input\b/` | `[QA-F1a]`…`[QA-F1f]` 6 例 | **6 红 / 其余全绿**，还原后全绿 | QA |
| 关闭数据项数组展开（`false && result.every(…)`） | `[QA-F2a]` `[QA-F2b]` `[QA-F2g]` 3 例 | **3 红 / 其余全绿**，还原后全绿 | QA |
| 摘掉 `src/nodes/code-node.ts:143` 的 `result.length > 0 &&` | `[QA-F3]`、`[QA-F3-n]`、`Code：逐项模式返回空数组…` | **精确 2 红**（`p0-adversarial`：33 pass / 2 fail），`code-node.test.ts` 24 例中 **1 红**（`expected: 2, actual: 0`） | QA + 主理人独立复核 |
| 同上，观察逆向护栏用例 | `[QA-F3-guard]` 应**保持绿** | **保持绿**（证明逐项守卫不越界影响整批路径） | 主理人独立复核 |

---

## 5. 实机 E2E 证据（`wrangler dev` @ 127.0.0.1:8787，干净树）

### 5.1 D2 —— last-successful 载荷契约

| 场景 | 实测 |
| --- | --- |
| 无成功执行 | HTTP 200，`{"data":null}` |
| 有成功执行 | 200；顶层含 `workflowData` + `data`；`data.resultData.runData` 含 `Start`、`CodeB`；`runData.CodeB[0].data.main[0]` = 实际输出项；`workflowData.nodes.length` = 2 |

### 5.2 Code 节点语义边界（12/12 通过）

| 场景 | 期望 | 实测 |
| --- | --- | --- |
| 整批模式 `return items.length >= 0 ? [] : []`（1 / 3 输入） | 0 项（n8n 正确语义，守卫不得越界） | **0 项** ✅ |
| 整批对照 `return items`（3 输入） | 3 项 | 3 项 ✅ |
| 逐项 `return [];`（1 / 3 / 5 输入） | 1 / 3 / 5 项，各含 `output:[]` | 1 / 3 / 5 项 ✅ |
| 逐项 `[{ json: { a: 1 } }]`（3 输入） | N×1 = 3 项 | 3 项 ✅ |
| 逐项 `{ json: {} }`（item 形态空 json） | 3 项 | 3 项 ✅ |
| 逐项 `return 'x';` / `return 0;` / `return null;` | 3 项，值置 `output` | 3 项 `output:'x'` / `0` / `null` ✅ |
| 逐项 `return;`（undefined） | 透传 3 项 | 3 项 ✅ |
| 逐项 `return [1, 2];` | 3 项各含 `output:[1,2]`（不展开） | 3 项 ✅ |
| 逐项 `return n * 2;` | 3 项 `output: 2/4/6` | 3 项 ✅ |
| 多输入 `return [1,2,3].map(x => ({json:{n:x}}))`（3 输入，不含 `items` 字样） | N×M = **9 项** | 9 项 ✅ |
| 第 5 项 `return { idx };` | execStatus `error` / 节点 `failed` / 文案含「简写」与 `{ idx: idx }` / `detail.error` 链路完整 | 全部满足 ✅ |
| F1 回归 `return json.items;`（3 输入） | 3 项（修复前 2 项） | 3 项 ✅ |

### 5.3 基线复测

安全面 + 契约面 + 执行引擎共 **80 项断言**全绿；排除 3 个误报（last-successful 状态映射属设计、`GET .../versions` 前端不调用、IF/失败传播查询过早）。

---

## 6. 流程问题与整改（非代码缺陷）

1. **证据污染（主理人自身）**：实机探针在「QA 未提交补丁 + `wrangler dev` 热重载」的工作树上运行，一度得出「`return []` 无缺陷」的错误结论。还原到 HEAD 后复测才暴露真缺陷。
   → **纪律**：任何实机结论必须标注**被测树状态**（HEAD sha / 带未提交改动），否则视为无效证据。
2. **QA 越界改 `src/`**：QA 直接实现了 F3 修复 → 等于自证（作者 = 验证者）。
   → 已还原 `src`（补丁留存 `.workbuddy/tmp/qa-r3/qa-r3-uncommitted.patch`），改派工程师实现；QA 的测试用例保留为 red→green 锚点。
   → **纪律**：QA 只改 `tests/`；`src/` 归工程师。
3. **提交范围超授权**：工程师 `7cc5c2c` 一次提交同时包含 `src/` 与其未提交的 QA 测试（内容与 QA 原 diff 逐字节一致，`205639c..ca1dd8a`），作者署名混合。
   → 未改写已提交历史（避免 rebase）；后续严格按「实现 / 测试」分开 `git add`。
4. **仓库根目录临时文件污染**：累计出现 QA 17 个 + 工程师 3 个 + QA 又 2 个（`qa-*.txt`、`f-*.txt`、`tmp-qa-r3.*`、`qaOnlyRunTest.txt`）。
   → 全部移入 `.workbuddy/tmp/{qa-r2,qa-r3,engineer-r3}/`；**纪律**：所有临时产物只写 `.workbuddy/tmp/`。
5. **并发测量互扰**：QA 跑全量测试时捕获 1 例瞬时红（工程师正在 `src` 上做变异开关窗口）。
   → **纪律**：变异/反向验证须串行或在独立副本上进行；报告需注明采样时点。

---

## 7. 遗留与未覆盖

| 项 | 说明 |
| --- | --- |
| 未部署线上实例 | 全部验证在本地 `wrangler dev` + 本地 D1 完成；未做线上灰度 |
| 受限求值器能力边界 | 块体箭头函数、`for`/`while`/`function`、对象简写属性**不支持**，均为**显式失败 + 能力边界提示**（Cloudflare Workers 禁用 `eval`/`new Function` 的硬约束），属既定设计而非缺陷 |
| 无法测「旧状态」快照 | `wrangler dev` 热重载工作树，实机只能测当前树；历史行为由节点级单测覆盖 |
| 测试用例轻微重叠 | `p0-adversarial.test.ts`（QA）与 `code-node.test.ts`（工程师）对 F1/F3 有部分重叠断言，属有意双保险，非冲突 |
