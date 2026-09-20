# mini-flow

把 n8n 的可视化工作流编排 + 节点执行能力，**原生化搬迁到 Cloudflare Workers** 的轻量引擎，并内置"防丢失与中断恢复"（检查点、幂等重试、死信队列、防重叠锁）。

前端 **100% 复用 n8n editor-ui**（不改源码），后端在 Workers 上复刻 n8n REST 契约 + Push(SSE) 协议，形成完整可用的可视化工作流平台。

> 权威决策见 [`DECISIONS.md`](./DECISIONS.md)。

---

## 架构总览

### 1. 系统部署架构（Cloudflare）

```mermaid
flowchart TB
    subgraph Client
        UI["浏览器 / n8n editor-ui SPA<br/>(Vue3, VUE_APP_URL_BASE_API 指向 /rest)"]
    end

    subgraph "Cloudflare Edge"
        UI -->|HTTPS| Worker
    end

    subgraph Worker["Cloudflare Worker <code>de9cc5... </code> (Hono 组装)"]
        direction TB
        REST["n8n REST 适配层<br/>/rest/*"]
        PUSH["Push SSE 门面<br/>/push · /rest/push"]
        ASSETS["静态资源托管<br/>/console + SPA fallback"]
        TPL["模板市场代理<br/>/templates/*"]
        CRON["Cron 调度<br/>*/15 * * * *"]
        CONSOLE["管理后台<br/>/console"]
    end

    REST --> PUSH
    ASSETS -->|frontend/dist| UI

    subgraph "Cloudflare 持久化 & 执行底座"
        D1[("D1 · mini-flow-db<br/>workflow / execution / 检查点 / DLQ")]
        KV[("KV · CREDENTIALS<br/>设置 / 密钥 / 去重游标")]
        DO["Durable Object · PushConnection<br/>SSE 事件转发"]
        WF["Workflows · FlowEngine<br/>断点续跑 + step 幂等重试"]
    end

    REST --> D1
    REST --> KV
    PUSH --> DO
    DO --> UI
    REST -->|提交执行| WF
    CRON -->|清理 / 补偿 / 定时工作流| D1
    CRON --> WF

    Worker --> Ext["外部系统<br/>Telegram t.me / 企业微信 webhook / 翻译 API / HTTP"]
```

### 2. 一次工作流执行的内部分层

```mermaid
sequenceDiagram
    autonumber
    participant UI as n8n editor-ui
    participant API as /rest 适配层
    participant EXEC as 引擎 executor / dag
    participant D1 as D1 控制面
    participant WF as Workflows FlowEngine
    participant DO as Durable Object SSE
    participant N as 节点执行器(nodes/*)

    UI->>API: POST /rest/workflows/:id/run
    API->>EXEC: 加载 D1 定义 → 编译 DAG → 抢锁
    EXEC->>D1: 写 execution + 检查点
    EXEC->>WF: 提交 step 序列(幂等)
    WF->>N: 顺序执行每个节点
    N->>N: 受限求值 / 内置执行器 / 外部调用
    WF->>DO: nodeExecuteAfter / finished 事件
    DO-->>UI: SSE 实时推送执行进度
    API-->>UI: GET /rest/executions/:id 结果兜底
```

### 3. 韧性四机制

```mermaid
flowchart LR
    L1["节点级检查点<br/>Checkpoint"] --> L2["幂等重试<br/>withRetry 指数退避"]
    L2 --> L3["死信队列 DLQ<br/>重试耗尽入表"]
    L3 --> L4["防重叠乐观锁<br/>Cron 抢锁失败跳过"]
    L3 -->|cron 扫描补偿| L3
```

---

## 目录结构

```
mini-flow/
├── wrangler.jsonc            # Worker + D1 + KV + Workflows + Durable Object + assets + cron
├── package.json / tsconfig.json
├── schema.sql                # D1 Schema（含恢复扩展表 + DLQ + 索引）
├── DECISIONS.md              # 已确认决策记录
├── migrations/               # 增量迁移 SQL（仅对已建库执行；新库直接用 schema.sql）
├── scripts/
│   ├── gen-nodes-json.ts     # 生成 nodes.json / node-versions.json（节点元数据前端同步）
│   └── run-tests.mjs         # 测试入口（node:test + tsx）
├── tests/                    # 单元 / 集成测试（helpers 内含真实 SQLite 支撑的 D1 垫片）
├── frontend/dist/            # n8n editor-ui 构建产物（复用，接入说明见 frontend/README.md）
└── src/
    ├── index.ts              # Hono 装配 + Push 挂载 + SPA fallback + cron 入口
    ├── types.ts              # 核心类型 + Env 绑定(DB/CREDENTIALS/PUSH/FLOW_ENGINE/ASSETS)
    ├── db/schema.ts          # 表结构定义（对应 schema.sql）
    ├── engine/               # 韧性核心
    │   ├── evaluator.ts      # 受限表达式求值器（替代 Code 节点的 new Function）
    │   ├── retry.ts          # withRetry 指数退避
    │   ├── checkpoint.ts     # 节点检查点读写与恢复
    │   ├── lock.ts           # 乐观锁 + 超时清理
    │   ├── dead-letter.ts    # DLQ 写入 / 扫描 / 重建
    │   ├── dag.ts            # n8n workflow JSON → 步骤序列（含条件分支）
    │   ├── route.ts          # 纯函数执行内核：拓扑序 / 分支路由 / 断点续跑
    │   ├── scheduler.ts      # 已激活定时工作流调度
    │   └── executor.ts       # 业务调度入口：锁 → 检查点 → 提交 Workflows
    ├── runtime/
    │   ├── flow-engine.ts    # extends WorkflowEntrypoint：step 断点续跑
    │   └── push.ts           # Durable Object：SSE Push 门面
    ├── nodes/                # 节点执行实现（真实可执行）
    │   ├── index.ts          # 节点注册表
    │   ├── telegram.ts       # t.me 公开频道抓取（无需 token）
    │   ├── messaging.ts      # 企业微信 webhook + 翻译
    │   ├── http-request.ts / notify.ts / webhook.ts
    │   ├── if-condition.ts / logic.ts / transform.ts / text.ts / util.ts / extra.ts
    │   ├── ai.ts / db.ts / code-node.ts
    │   └── triggers.ts / common.ts
    ├── plugins/              # 插件化节点注册
    │   ├── builtin.ts        # n8n-nodes-base 全量节点定义（含执行器）
    │   ├── registry.ts       # 插件注册中心
    │   └── types.ts / index.ts
    └── n8n/                  # n8n REST 契约适配层
        ├── router.ts         # /rest/* 路由聚合
        ├── auth.ts / settings.ts / aux.ts / projects.ts
        ├── node-types.ts     # nodeTypes 元数据（由 plugins 注册表输出）
        ├── workflows.ts      # workflows CRUD + run
        ├── executions.ts     # executions 列表 / 详情 / 重试
        ├── templates.ts / templates-presets.ts  # 模板市场代理 + 预设
        ├── webhook.ts        # 外部触发：/webhook · /webhook-test · /form 匹配与回包
        ├── insights.ts       # /rest/insights/* 执行统计聚合
        ├── tags.ts           # /rest/tags CRUD
        ├── community-nodes.ts# 社区节点安装 / 卸载登记
        ├── dead-letter.ts    # DLQ 管理端点
        ├── console.ts        # 管理后台页
        └── push.ts           # 与 runtime/push 对接，订阅执行事件
```

---

## 运行时绑定

| 绑定 | 类型 | 用途 |
| --- | --- | --- |
| `DB` | D1 | workflow 定义、execution、检查点、锁、DLQ（`mini-flow-db`） |
| `CREDENTIALS` | KV | 用户设置、密钥、翻译/消息去重游标 |
| `PUSH` | Durable Object | SSE 门面，把执行进度转发给前端 |
| `FLOW_ENGINE` | Workflows | 断点续跑 + step 幂等重试（`FlowEngine`） |
| `ASSETS` | Static Assets | 托管 `frontend/dist`（n8n editor-ui） |
| cron | `*/15 * * * *` | 锁清理 + DLQ 补偿 + 定时工作流 |

---

## 快速开始

```bash
npm install
# 1) 建 D1
npx wrangler d1 create mini-flow-db            # 把 database_id 填进 wrangler.jsonc
npx wrangler d1 execute mini-flow-db --file=schema.sql
# 2) 本地（必须先把示例变量复制为 .dev.vars，否则登录会 503）
cp .dev.vars.example .dev.vars
npm run dev
# 3) 类型检查 + 测试
npm run type-check
npm test
# 4) 同步节点元数据到前端（已在 predeploy 自动执行）
npm run gen:nodes
# 5) 配置生产 Secret（必须，否则实例「失败关闭」无法登录）
npx wrangler secret put ADMIN_PASSWORD         # 口令 >= 8 位
npx wrangler secret put SESSION_SECRET         # 会话签名密钥 >= 16 位
# 6) 部署（predeploy 自动执行 gen:nodes + 部署前自检）
MINI_FLOW_SECRETS_CONFIRMED=1 npm run deploy
```

### 部署必读：凭据与部署前自检

**凭据守卫（失败关闭）**：`ADMIN_PASSWORD` / `SESSION_SECRET` 必须通过 Worker Secret 配置。
两者任一缺失或过短时，`/rest/login` 返回 **503** 并给出修复指引，所有受保护路由返回 **401**
—— 实例变为「不可用」，而**不会**回退到公开的默认口令。

内置的开发回退口令**只在 `ENVIRONMENT` 显式为 `development` / `dev` / `local` 时生效**
（写入 `.dev.vars`，该文件已被 `.gitignore` 忽略）。判定只看环境变量、**不看请求 Host**，
因此伪造 `Host: localhost` 无法绕过。生产可显式设置 `ENVIRONMENT=production` 以双保险。

**部署前自检**（`scripts/predeploy-check.mjs`，挂在 `predeploy` 钩子上，失败即中止部署）：

| 类别 | 检查内容 |
| --- | --- |
| 结构 | D1 `DB` / KV `CREDENTIALS` / DO `PUSH` / Workflows `FLOW_ENGINE` 绑定齐全；`frontend/dist/index.html` 已构建 |
| 安全 | 需 `MINI_FLOW_SECRETS_CONFIRMED=1` 显式确认已配置 Secret；凭据守卫在位；回退口令未扩散到其它源文件 |
| 卫生 | `.gitignore` 已忽略 `.dev.vars` |
| 迁移 | `migrations/*.sql` 新增表/列已同步进 `schema.sql` |

> 注意：`predeploy` 由 npm 生命周期触发。直接 `npx wrangler deploy` 会跳过该自检。

---

## 内置节点

共 **约 68 个节点**，通过插件注册中心统一管理元数据与执行器，保证"编辑器面板"与"运行时执行"同源（图标、参数、行为一致）。

核心分类：

- **触发器**：Manual Trigger / Webhook / 定时 Cron / Form Trigger / Interval Trigger / Error Trigger
- **Telegram 抓取**：`Telegram Channel`（抓取 t.me 公开频道最近消息，无需 token）
- **数据处理**：IF / Switch / Set / Merge / Filter / Sort / Aggregate / Math / Date & Time / Limit / Rename Keys / Zip / Item Lists / Flatten / Split To Items / Pick & Remove Fields / Assign / Convert To JSON / Join List
- **文本处理**：Text Replace / Regex Extract / Text Case / Text Split / Text Template / Text Truncate / Text Count / Text Trim / Text Slice
- **通信 / 通知**：企业微信 `weCom`（群机器人 webhook）、HTTP Send / Webhook Send、Telegram / Slack / Discord / Email / SendGrid（占位，需凭据）
- **翻译**：`Translate`（Google 免费 / MyMemory / OpenAI 兼容引擎可配，未配回退原文）
- **存储**：D1 Query / SQLite / KV `Store`
- **AI**：OpenAI Chat（OpenAI 兼容，如 Workers AI）/ Embeddings / Hugging Face（后两者占位）
- **辅助**：Sticky Note / NoOp / Output / Delay / Split In Batches / Remove Duplicates / Add Metadata

---

## 典型业务场景

最简 `Telegram → 翻译 → 企业微信` 工作流：

```mermaid
flowchart LR
    TG["Telegram<br/>定时 Cron 触发<br/>n8n-nodes-base.scheduleTrigger"]
    GRAB["Telegram Channel 抓取<br/>n8n-nodes-base.telegramChannelReader"]
    DE["去除重复 / 去噪<br/>Remove Duplicates + Filter"]
    TR["Translate<br/>n8n-nodes-base.translate"]
    DIG["文本整合摘要<br/>Join List / Text Template"]
    WX["企业微信 Webhook<br/>n8n-nodes-base.weCom"]

    TG --> GRAB --> DE --> TR --> DIG --> WX
```

节点执行细节（见 `src/nodes/telegram.ts`、`src/nodes/messaging.ts`）：

- **抓取**：解析 t.me/s/ 公开页 HTML，提取时间、作者、文本，做数字实体解码与噪音过滤。
- **翻译**：`translateNode` 按引擎配置调用 Google / MyMemory / OpenAI 兼容接口；目标简体中文且原文已是中文时直通，翻译失败回退原文，保证下游非空。密钥可从节点参数或 KV `openai_api_key` 读取。
- **整合推送**：`weComSendNode` 把多条输入整合成按频道分组的 markdown 摘要（每频道限条、总条数上限、超长截断、微信 4096 字节护栏），POST 到企业微信群机器人 webhook（`key=` 校验）。

---

## 状态

- [x] 前端复用 n8n editor-ui（图标 / 参数面板 NDV / 节点面板 / 控制面板均已接通）
- [x] 节点注册中心 + 68 个内置节点（同源元数据与执行器）
- [x] n8n REST 契约适配（settings/auth/workflows/executions/node-types/projects/templates…）
- [x] 韧性四机制（检查点 / 幂等重试 / DLQ / 防重叠锁） + Workflows 断点续跑
- [x] Push SSE 门面（Durable Object）
- [x] Telegram 抓取 → 翻译 → 企业微信推送闭环
- [x] 鉴权加固：HMAC 签名会话令牌 + `/rest/*` 全局鉴权墙 + 凭据出站脱敏
- [x] 执行引擎语义对齐：仅执行已连线节点 / IF 分支互斥 / 节点失败显式上报
- [x] 外部触发落地：`/webhook/:path` · `/webhook-test/:path` · `/form/:path`（含 responseMode 三态回包）
- [x] 节点可配置化：68/68 节点 `properties` 非空 + 11 节点 `credentials` 声明
- [x] REST 能力端点补齐：executions retry / insights / tags CRUD / 工作流导入导出 / 社区节点登记
- [x] 回归测试体系：`npm test` 129 例（含反向验证探针，可捕获注入缺陷）
- [x] 凭据守卫：`ADMIN_PASSWORD` / `SESSION_SECRET` 未配置时**失败关闭**（登录 503、受保护路由 401），
      开发回退口令仅在 `ENVIRONMENT=development|dev|local` 生效（判定不看请求 Host，防伪造绕过）
- [x] 外部触发确定性：同名 webhook/form path 按 `created_at, rowid` 稳定选取最早创建者
- [x] `projectId` 语义统一为 `personal`（历史 NULL 行读时归一 + 过滤兼容），与 `/rest/projects` 一致
- [x] 部署前自检门禁 `scripts/predeploy-check.mjs`（绑定完整性 / Secret 确认 / 防密钥入库 / 迁移一致性）