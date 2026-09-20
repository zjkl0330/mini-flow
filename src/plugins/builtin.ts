// plugins/builtin: 内置插件 —— n8n-nodes-base 全套基础节点
// 以插件形式把节点元数据 + 执行逻辑统一注册。node-types 只读 registry 输出，
// 保证"编辑器节点面板"与"运行时执行"始终同源，彻底避免节点漏注册。
import type { NodePlugin, PluginNodeType, NodeCredentialRef } from './types';
import type { MiniNodeType } from '../n8n/node-types';
import { registerPlugin } from './registry';

import { manualTriggerNode, webhookNode, scheduleNode } from '../nodes/webhook';
import { httpRequestNode } from '../nodes/http-request';
import { setNode, ifNode } from '../nodes/if-condition';
import { codeNode } from '../nodes/code-node';
import { mergeNode, splitInBatchesNode, delayNode, outputNode } from '../nodes/common';
import {
  noOpNode, errorTriggerNode, respondToWebhookNode, switchNode, removeDuplicatesNode, textSplitterNode,
} from '../nodes/logic';
import { filterNode, sortNode, aggregateNode, mathNode, dateTimeNode, extractJsonNode, editFieldsNode } from '../nodes/transform';
import { d1QueryNode, dbPlaceholderNode } from '../nodes/db';
import { cronNode, formTriggerNode, intervalNode } from '../nodes/triggers';
import { openaiChatNode, aiPlaceholderNode } from '../nodes/ai';
import { textReplaceNode, regexExtractNode, textCaseNode, textSplitNode, textTemplateNode, textTruncateNode, textCountNode } from '../nodes/text';
import { limitNode, renameKeysNode, zipNode, itemListsNode, storeNode, convertToJsonNode, joinListNode, assignNode } from '../nodes/util';
import { httpSendNode, notifyPlaceholderNode, webhookSendNode } from '../nodes/notify';
import { telegramChannelNode } from '../nodes/telegram';
import { weComSendNode, translateNode } from '../nodes/messaging';
import {
  keepFieldsNode, dropFieldsNode, textTrimNode, textSliceNode, flattenNode, splitToItemsNode, addMetaNode,
} from '../nodes/extra';

type Def = Omit<PluginNodeType, 'typeVersion' | 'version' | 'type'> & {
  type: string; typeVersion: number; version: number | number[];
  executor: NodePlugin['nodes'][number]['executor'];
};

// n8n 编辑器节点面板子分类键（常量取自前端 src/app/constants/nodeCreator.ts）：
// 面板按子分类键精确匹配 —— TRANSFORM_DATA_SUBCATEGORY='Data Transformation'、
// FLOWS_CONTROL_SUBCATEGORY='Flow'、HELPERS_SUBCATEGORY='Helpers'、
// AI_CATEGORY_LANGUAGE_MODELS='Language Models'、AI_CATEGORY_EMBEDDING='Embeddings'。
// subcategorizeItems() 只把 codex.categories 命中白名单 ['Core Nodes','AI','HITL'] 的节点
// 用 codex.subcategories[该分类] 的第一个键作为子分类；键必须与上面常量逐字一致，
// 否则节点既不匹配任何子分类、又被剔除，导致分类面板空白。
// 未命中白名单或无 subcategories 的节点落入 DEFAULT_SUBCATEGORY='*'（"Action in an app"）兜底桶。
const SUB = {
  CORE: 'Helpers',            // HELPERS_SUBCATEGORY → "Core"
  DATA: 'Data Transformation', // TRANSFORM_DATA_SUBCATEGORY → "Data transformation"
  FLOW: 'Flow',               // FLOWS_CONTROL_SUBCATEGORY → "Flow"
} as const;

// 便捷构造：统一补齐 meta 字段，保证 defaults.name / defaults.color 存在
function def(partial: {
  type: string; name: string; displayName: string; description: string;
  group: string[]; categories?: string[]; icon: string;
  inputs: string[] | string; outputs: string[] | string;
  color?: string; properties?: any[]; version?: number | number[]; typeVersion?: number;
  codex?: MiniNodeType['codex'];
  // 常规节点子分类：交给 def() 自动生成 codex，让节点出现在面板对应根分类。
  subcategory?: string; primaryCategory?: string;
  // 需要鉴权的节点声明的凭据（REQ-17）；name 必须存在于 credentials.ts 的 credentialTypes()。
  credentials?: NodeCredentialRef[];
  executor?: any;
}): PluginNodeType {
  const { type, displayName, color, properties: props, executor } = partial;
  // 关键：n8n 的 INodeTypeDescription.name 必须等于完整类型(type)，而非可读标签。
  // 前端 nodeTypes store 用 nodeType.name 建索引，getNodeType(node.type) 按其查询；
  // 若 name 用短标签("Manual Trigger")，画布用 type("n8n-nodes-base.manualTrigger")
  // 查表会 miss → 图标渲染成 "?" 且无法打开参数面板。故这里强制 name=type。
  // displayName 中文字段友好：defaults.name 用 short 标签（去空格取首个词）
  const short = displayName.length <= 14 ? displayName : displayName.split(/\s+/)[0];
  const hasExplicitCategories = partial.categories !== undefined;
  // codex: 供 n8n 编辑器面板按官方分类协议归类。关键：
  // - 常规节点画布面板以 codex.categories 命中白名单 ['Core Nodes','AI','Human in the Loop']
  //   后用 codex.subcategories[该分类][0] 作为子分类键（决定落在 Data transformation/Flow/Core）。
  // - 只补 categories 不补 subcategories 仍会掉进 "*"(Action in an app) 兜底桶，故这里用
  //   subcategory 参数自动生成完整 codex。
  let codex = partial.codex;
  if (!codex) {
    const cat = partial.primaryCategory ?? 'Core Nodes';
    if (partial.subcategory) {
      codex = { categories: [cat], subcategories: { [cat]: [partial.subcategory] } };
    } else if (!hasExplicitCategories) {
      codex = { categories: [cat] };
    }
  }
  return {
    type, name: type, typeVersion: partial.typeVersion ?? 1, version: partial.version ?? [1],
    displayName, description: partial.description,
    group: partial.group, categories: partial.categories ?? ['Core Nodes'],
    codex,
    icon: partial.icon, defaults: { name: short, color: color ?? '#8064a2', typeVersion: partial.typeVersion ?? 1 },
    inputs: partial.inputs, outputs: partial.outputs, properties: props ?? [], executor,
    // 白名单透传：credentials 未在返回对象里列出时会被丢失，导致 NDV 选不到凭据。
    ...(partial.credentials ? { credentials: partial.credentials } : {}),
  };
}

// 只读 notice 属性：给「合法无参数」的触发器/装饰节点（manualTrigger/errorTrigger/stickyNote/noOp）
// 各补一个无交互、无副作用的说明项，使 68/68 节点 properties 非空（REQ-16 字面成立）。
const noticeProp = (text: string) => ({ displayName: text, name: 'notice', type: 'notice', default: '' });

const nodes: PluginNodeType[] = [
  // ---- 触发器 ----
  def({ type: 'n8n-nodes-base.manualTrigger', name: 'Manual Trigger', displayName: 'Manual Trigger', description: '在编辑器中点击按钮手动触发', group: ['trigger'], icon: 'fa:mouse-pointer', color: '#ff6d5a', inputs: [], outputs: ['main'],
    properties: [noticeProp('点击编辑器上的「Execute workflow」按钮即可手动触发本工作流，无需额外参数。')],
    executor: manualTriggerNode }),
  def({ type: 'n8n-nodes-base.webhook', name: 'Webhook', displayName: 'Webhook', description: '通过 URL 接收请求触发', group: ['trigger'], icon: 'fa:globe', inputs: [], outputs: ['main'],
    properties: [
      { displayName: 'HTTP Method', name: 'httpMethod', type: 'options', noDataExpression: true, default: 'GET', options: ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT'].map((m) => ({ name: m, value: m })) },
      { displayName: 'Path', name: 'path', type: 'string', noDataExpression: true, required: true, default: '', placeholder: 'webhook', description: '监听该路径上的请求' },
    ], executor: webhookNode }),
  def({ type: 'n8n-nodes-base.scheduleTrigger', name: 'Scheduled Trigger', displayName: '定时 Cron', description: '按计划自动运行', group: ['trigger'], icon: 'fa:clock', inputs: [], outputs: ['main'],
    properties: [
      { displayName: 'Rule Type', name: 'rule', type: 'options', noDataExpression: true, default: 'interval', options: [{ name: 'Cron Expression', value: 'cron' }, { name: 'Interval', value: 'interval' }] },
      { displayName: 'Cron Expression', name: 'cronExpression', type: 'string', default: '0 0 * * *' },
      { displayName: 'Interval (minutes)', name: 'minutesInterval', type: 'number', default: 60 },
    ], executor: scheduleNode }),

  // ---- 数据操作 ----
  def({ type: 'n8n-nodes-base.if', name: 'IF', displayName: '条件判断 IF', description: '按条件选择分支', group: ['transform'], icon: 'fa:code-branch', inputs: ['main'], outputs: ['main', 'main'],
    subcategory: SUB.FLOW,
    properties: [
      { displayName: 'Field', name: 'conditionSt', type: 'string', default: '' },
    ], executor: ifNode }),
  def({ type: 'n8n-nodes-base.switch', name: 'Switch', displayName: 'Switch', description: '多分支路由', group: ['transform'], icon: 'fa:code-branch', inputs: ['main'], outputs: ['main'], subcategory: SUB.FLOW,
    properties: [
      { displayName: 'Mode', name: 'mode', type: 'options', noDataExpression: true, default: 'rules', options: [{ name: 'Rules', value: 'rules' }, { name: 'Expression', value: 'expression' }] },
      { displayName: 'Rules', name: 'rules', type: 'fixedCollection', default: {}, typeOptions: { multipleValues: true }, options: [{ name: 'values', displayName: 'Rule', values: [
        { displayName: 'Conditions', name: 'conditions', type: 'fixedCollection', default: {}, typeOptions: { multipleValues: true }, options: [{ name: 'conditions', displayName: 'Condition', values: [
          { displayName: 'Left Value', name: 'leftValue', type: 'string', default: '' },
          { displayName: 'Operation', name: 'operator', type: 'string', default: 'equals' },
          { displayName: 'Right Value', name: 'rightValue', type: 'string', default: '' },
        ] }] },
      ] }] },
    ], executor: switchNode }),
  def({ type: 'n8n-nodes-base.set', name: 'Set', displayName: '字段赋值 Set', description: '写入字段值', group: ['transform'], icon: 'fa:pen', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    // 属性名取执行器读取键 assignments.assignments（§6 的「values」会使面板可填但不生效）。
    properties: [
      { displayName: 'Assignments', name: 'assignments', type: 'fixedCollection', default: {}, typeOptions: { multipleValues: true }, options: [{ name: 'assignments', displayName: 'Assignment', values: [
        { displayName: 'Name', name: 'name', type: 'string', default: '' },
        { displayName: 'Value', name: 'value', type: 'string', default: '' },
      ] }] },
      { displayName: 'Keep Only Set', name: 'keepOnlySet', type: 'boolean', default: false },
    ], executor: setNode }),
  def({ type: 'n8n-nodes-base.merge', name: 'Merge', displayName: 'Merge', description: '合并分支数据', group: ['transform'], icon: 'fa:code-merge', inputs: ['main', 'main'], outputs: ['main'], subcategory: SUB.FLOW,
    properties: [
      { displayName: 'Mode', name: 'mode', type: 'options', noDataExpression: true, default: 'append', options: [{ name: 'Append', value: 'append' }, { name: 'Combine', value: 'combine' }] },
    ], executor: mergeNode }),
  def({ type: 'n8n-nodes-base.removeDuplicates', name: 'Remove Duplicates', displayName: 'Remove Duplicates', description: '按字段去重', group: ['transform'], icon: 'fa:clone', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    // 执行器读取键为 options.pairing，故外层属性名用 options。
    properties: [
      { displayName: 'Options', name: 'options', type: 'collection', default: {}, placeholder: 'Add Option', options: [
        { displayName: 'Compare Field Pairs', name: 'pairing', type: 'fixedCollection', default: {}, typeOptions: { multipleValues: true }, options: [{ name: 'pairing', displayName: 'Field Pair', values: [
          { displayName: 'Field 1', name: 'field1', type: 'string', default: '' },
          { displayName: 'Field 2', name: 'field2', type: 'string', default: '' },
        ] }] },
      ] },
    ], executor: removeDuplicatesNode }),
  def({ type: 'n8n-nodes-base.splitInBatches', name: 'Split In Batches', displayName: 'Split In Batches', description: '分批处理', group: ['transform'], icon: 'fa:columns', inputs: ['main'], outputs: ['main'], subcategory: SUB.FLOW,
    properties: [{ displayName: 'Batch Size', name: 'batchSize', type: 'number', default: 10, description: '每批处理的数据条数' }],
    executor: splitInBatchesNode }),
  def({ type: 'n8n-nodes-base.delay', name: 'Delay', displayName: 'Delay', description: '延迟/节流', group: ['transform'], icon: 'fa:clock', inputs: ['main'], outputs: ['main'], subcategory: SUB.FLOW,
    properties: [
      { displayName: 'Amount', name: 'amount', type: 'number', default: 0 },
      { displayName: 'Unit', name: 'unit', type: 'options', default: 'seconds', options: [{ name: 'Milliseconds', value: 'milliseconds' }, { name: 'Seconds', value: 'seconds' }, { name: 'Minutes', value: 'minutes' }] },
    ], executor: delayNode }),
  def({ type: 'n8n-nodes-base.httpRequest', name: 'HTTP Request', displayName: 'HTTP Request', description: '调用外部 HTTP 接口', group: ['transform'], icon: 'fa:paper-plane', inputs: ['main'], outputs: ['main'], subcategory: SUB.CORE,
    properties: [
      { displayName: 'Method', name: 'method', type: 'options', noDataExpression: true, default: 'GET', options: ['DELETE', 'GET', 'HEAD', 'PATCH', 'POST', 'PUT'].map((m) => ({ name: m, value: m })) },
      { displayName: 'URL', name: 'url', type: 'string', required: true, default: '', placeholder: 'https://example.com' },
      { displayName: 'Body', name: 'jsonBody', type: 'string', typeOptions: { rows: 4 }, default: '' },
      { displayName: 'Ignore HTTP Status Errors', name: 'ignoreHttpStatusErrors', type: 'boolean', default: false, description: '开启后，非 2xx 响应不再让节点失败，而是把响应体作为数据返回' },
    ],
    // REQ-17：可选 HTTP 认证凭据（Header / Basic / Query）
    credentials: [{ name: 'httpHeaderAuth' }, { name: 'httpBasicAuth' }, { name: 'httpQueryAuth' }],
    executor: httpRequestNode }),

  // ---- 代码/流程 ----
  def({ type: 'n8n-nodes-base.code', name: 'Code', displayName: 'Code', description: '受限表达式求值', group: ['transform'], icon: 'fa:code', color: '#ff6d5a', inputs: ['main'], outputs: ['main'],
    subcategory: SUB.CORE,
    properties: [{ displayName: 'Javascript', name: 'javascriptCode', type: 'string', typeOptions: { editor: 'codeNodeEditor', rows: 8 }, default: 'return $json;' }], executor: codeNode }),
  def({ type: 'n8n-nodes-base.function', name: 'Function', displayName: '受限求值', description: '安全公式与函数（受限，非任意 JS）', group: ['transform'], icon: 'fa:tachometer-alt', color: '#ff6d5a', inputs: ['main'], outputs: ['main'], subcategory: SUB.CORE,
    properties: [
      { displayName: 'Expression', name: 'code', type: 'string', typeOptions: { rows: 6 }, default: 'return $json;' },
      noticeProp('受限表达式求值（非任意 JS）：Workers 环境禁用 eval / new Function，仅支持 $json 字段引用、四则运算与白名单函数。'),
    ], executor: codeNode }),
  def({ type: 'n8n-nodes-base.outputNode', name: 'Output', displayName: 'Output', description: '结果透出', group: ['transform'], icon: 'fa:sign-out-alt', inputs: ['main'], outputs: ['main'], subcategory: SUB.CORE,
    properties: [{ displayName: 'Outputs', name: 'outputs', type: 'options', default: 'last', options: [{ name: 'First Item', value: 'first' }, { name: 'Last Item', value: 'last' }] }],
    executor: outputNode }),

  // ---- 辅助/透传 ----
  def({ type: 'n8n-nodes-base.noOp', name: 'NoOp', displayName: 'NoOp', description: '透传（无操作）', group: ['transform'], icon: 'fa:circle', inputs: ['main'], outputs: ['main'], subcategory: SUB.FLOW,
    properties: [noticeProp('NoOp 节点不做任何处理，仅将输入原样透传给下游。')],
    executor: noOpNode }),
  def({ type: 'n8n-nodes-base.respondToWebhook', name: 'Respond To Webhook', displayName: 'Respond To Webhook', description: '回显输入', group: ['trigger'], icon: 'fa:undo', inputs: ['main'], outputs: ['main'],
    properties: [
      { displayName: 'Respond With', name: 'respondWith', type: 'options', default: 'allIncomingItems', options: [{ name: 'All Incoming Items', value: 'allIncomingItems' }, { name: 'JSON', value: 'json' }, { name: 'Text', value: 'text' }] },
      { displayName: 'Response Code', name: 'responseCode', type: 'number', default: 200, description: '返回给外部调用方的 HTTP 状态码（默认 200）' },
    ], executor: respondToWebhookNode }),
  def({ type: 'n8n-nodes-base.errorTrigger', name: 'Error Trigger', displayName: 'Error Trigger', description: '错误触发（透传）', group: ['trigger'], icon: 'fa:exclamation-circle', inputs: [], outputs: ['main'],
    properties: [noticeProp('当关联工作流发生错误时自动触发（透传错误上下文），无需额外参数。')],
    executor: errorTriggerNode }),
  def({ type: 'n8n-nodes-base.stickyNote', name: 'Sticky Note', displayName: '便签', description: '画布便签，无逻辑', group: ['auxiliary'], icon: 'fa:sticky-note', inputs: [], outputs: [],
    properties: [noticeProp('画布便签仅用于注释说明，不参与执行。')],
    executor: noOpNode }),
  def({ type: 'n8n-nodes-base.textSplitter', name: 'Text Splitter', displayName: 'Text Splitter', description: '递归文本切块', group: ['transform'], icon: 'fa:scissors', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [
      { displayName: 'Text', name: 'text', type: 'string', typeOptions: { rows: 4 }, default: '', description: '待切分的文本，支持 {{ $json.field }} 引用' },
      { displayName: 'Chunk Size', name: 'chunkSize', type: 'number', default: 4000 },
      { displayName: 'Chunk Overlap', name: 'chunkOverlap', type: 'number', default: 200 },
    ],
    executor: textSplitterNode }),

  // ---- 数据转换/工具（真实可执行） ----
  def({ type: 'n8n-nodes-base.filter', name: 'Filter', displayName: 'Filter', description: '按条件过滤行', group: ['transform'], icon: 'fa:filter', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [
      { displayName: 'Conditions', name: 'conditions', type: 'fixedCollection', default: {}, typeOptions: { multipleValues: true }, options: [{ name: 'conditions', displayName: 'Condition', values: [
        { displayName: 'Left Value', name: 'leftValue', type: 'string', default: '' },
        { displayName: 'Operation', name: 'operator', type: 'string', default: 'equals' },
        { displayName: 'Right Value', name: 'rightValue', type: 'string', default: '' },
      ] }] },
      { displayName: 'Combinator', name: 'combinator', type: 'options', default: 'and', options: [{ name: 'And', value: 'and' }, { name: 'Or', value: 'or' }] },
    ], executor: filterNode }),
  def({ type: 'n8n-nodes-base.sort', name: 'Sort', displayName: 'Sort', description: '按字段排序', group: ['transform'], icon: 'fa:sort', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    // 执行器读取键为 rules.rules，故属性名用 rules（§6 的「sortBy」会使面板可填但不生效）。
    properties: [
      { displayName: 'Sort By', name: 'rules', type: 'fixedCollection', default: {}, typeOptions: { multipleValues: true }, options: [{ name: 'rules', displayName: 'Sort Field', values: [
        { displayName: 'Field', name: 'field', type: 'string', default: '' },
        { displayName: 'Direction', name: 'type', type: 'options', default: 'ascending', options: [{ name: 'Ascending', value: 'ascending' }, { name: 'Descending', value: 'descending' }] },
      ] }] },
    ], executor: sortNode }),
  def({ type: 'n8n-nodes-base.aggregate', name: 'Aggregate', displayName: 'Aggregate', description: '分组聚合(sum/count/avg/min/max)', group: ['transform'], icon: 'fa:table', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [{ displayName: 'Fields', name: 'fields', type: 'json', default: '[]', description: 'JSON 数组：[{ field, aggregation, grouping? }]' }],
    executor: aggregateNode }),
  def({ type: 'n8n-nodes-base.math', name: 'Math', displayName: 'Math', description: '四则/公式运算', group: ['transform'], icon: 'fa:calculator', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [{ displayName: 'Expression', name: 'expression', type: 'string', default: '', placeholder: '{{ $json.a }} + {{ $json.b }}' }],
    executor: mathNode }),
  def({ type: 'n8n-nodes-base.dateTime', name: 'Date & Time', displayName: 'Date & Time', description: '日期时间计算', group: ['transform'], icon: 'fa:calendar', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [
      { displayName: 'Date Property', name: 'dateProperty', type: 'string', default: '', description: '用于计算的日期字段名（留空取当前时间）' },
      { displayName: 'Additional Fields', name: 'additionalFields', type: 'collection', default: {}, placeholder: 'Add Field', options: [
        { displayName: 'Add', name: 'add', type: 'json', default: '{"value":0,"unit":"days"}', description: '{ value, unit: days|hours|minutes|weeks|months|years|milliseconds }' },
      ] },
    ], executor: dateTimeNode }),
  def({ type: 'n8n-nodes-base.extractFromFile', name: 'Extract From File', displayName: 'Extract From File', description: '从 JSON 提取字段', group: ['transform'], icon: 'fa:file', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [{ displayName: 'Source Key', name: 'sourceKey', type: 'string', default: 'json', description: '存放 JSON 字符串的字段名' }],
    executor: extractJsonNode }),
  def({ type: 'n8n-nodes-base.editFields', name: 'Edit Fields', displayName: 'Edit Fields (Set 多字段)', description: '批量写入字段', group: ['transform'], icon: 'fa:pen', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [
      { displayName: 'Mode', name: 'mode', type: 'options', default: 'merge', options: [{ name: 'Merge (保留原字段)', value: 'merge' }, { name: 'Set (覆盖)', value: 'set' }] },
      { displayName: 'Fields', name: 'fields', type: 'json', default: '[]', description: 'JSON 数组：[{ name, value }]' },
    ], executor: editFieldsNode }),

  // ---- 数据库 ----
  def({ type: 'n8n-nodes-base.d1query', name: 'D1 Query', displayName: 'D1 Query', description: '对 Cloudflare D1(SQLite) 执行 SQL', group: ['action'], categories: ['Database'], icon: 'fa:database', inputs: ['main'], outputs: ['main'], subcategory: SUB.CORE,
    properties: [{ displayName: 'SQL Query', name: 'query', type: 'string', required: true, default: '', typeOptions: { editor: 'sqlEditor', rows: 5 }, description: '支持 {{ $json.x }} 插值' }], executor: d1QueryNode }),
  def({ type: 'n8n-nodes-base.mySql', name: 'MySQL', displayName: 'MySQL', description: 'MySQL 数据库（需外部连接）', group: ['action'], categories: ['Database'], icon: 'fa:database', inputs: ['main'], outputs: ['main'], subcategory: SUB.CORE,
    properties: [
      { displayName: 'Connection', name: 'connection', type: 'fixedCollection', default: {}, options: [{ name: 'connection', displayName: 'Connection', values: [
        { displayName: 'Host', name: 'host', type: 'string', default: 'localhost' },
        { displayName: 'Port', name: 'port', type: 'number', default: 3306 },
        { displayName: 'User', name: 'user', type: 'string', default: '' },
        { displayName: 'Password', name: 'password', type: 'string', typeOptions: { password: true }, default: '' },
        { displayName: 'Database', name: 'database', type: 'string', default: '' },
      ] }] },
      noticeProp('当前 Worker 环境未配置外部 MySQL 连接：本节点为占位（不伪造查询结果）。如需真实查询请用 D1 Query 或 HTTP Request 直连数据库 API。'),
    ],
    credentials: [{ name: 'mySql', required: true }],
    executor: dbPlaceholderNode }),
  def({ type: 'n8n-nodes-base.postgres', name: 'PostgreSQL', displayName: 'PostgreSQL', description: 'PostgreSQL 数据库（需外部连接）', group: ['action'], categories: ['Database'], icon: 'fa:database', inputs: ['main'], outputs: ['main'], subcategory: SUB.CORE,
    properties: [
      { displayName: 'Connection', name: 'connection', type: 'fixedCollection', default: {}, options: [{ name: 'connection', displayName: 'Connection', values: [
        { displayName: 'Host', name: 'host', type: 'string', default: 'localhost' },
        { displayName: 'Port', name: 'port', type: 'number', default: 5432 },
        { displayName: 'User', name: 'user', type: 'string', default: '' },
        { displayName: 'Password', name: 'password', type: 'string', typeOptions: { password: true }, default: '' },
        { displayName: 'Database', name: 'database', type: 'string', default: '' },
      ] }] },
      noticeProp('当前 Worker 环境未配置外部 PostgreSQL 连接：本节点为占位（不伪造查询结果）。'),
    ],
    credentials: [{ name: 'postgres', required: true }],
    executor: dbPlaceholderNode }),
  def({ type: 'n8n-nodes-base.sqlite', name: 'SQLite', displayName: 'SQLite', description: 'SQLite 数据库', group: ['action'], categories: ['Database'], icon: 'fa:database', inputs: ['main'], outputs: ['main'], subcategory: SUB.CORE,
    properties: [{ displayName: 'Query', name: 'query', type: 'string', required: true, default: '', typeOptions: { editor: 'sqlEditor', rows: 5 }, description: '在 D1(SQLite) 上执行，支持 {{ $json.x }} 插值' }],
    executor: d1QueryNode }),

  // ---- 触发器补充 ----
  def({ type: 'n8n-nodes-base.cron', name: 'Cron', displayName: 'Cron', description: '按 cron 表达式定时触发', group: ['trigger'], icon: 'fa:calendar', inputs: [], outputs: ['main'],
    properties: [{ displayName: 'Cron Expression', name: 'cronExpression', type: 'string', default: '0 * * * *' }], executor: cronNode }),
  def({ type: 'n8n-nodes-base.formTrigger', name: 'Form Trigger', displayName: 'Form Trigger', description: '外部表单提交触发', group: ['trigger'], icon: 'fa:file-alt', inputs: [], outputs: ['main'],
    properties: [
      { displayName: 'Path', name: 'path', type: 'string', required: true, default: '', placeholder: 'my-form', description: '对外表单路径：/form/<path>' },
      { displayName: 'Form Title', name: 'formTitle', type: 'string', default: '' },
      { displayName: 'Form Fields', name: 'formFields', type: 'json', default: '[]', description: 'JSON 数组：[{ fieldName, fieldLabel, fieldType }]' },
    ], executor: formTriggerNode }),
  def({ type: 'n8n-nodes-base.intervalTrigger', name: 'Interval Trigger', displayName: 'Interval Trigger', description: '按固定间隔触发', group: ['trigger'], icon: 'fa:repeat', inputs: [], outputs: ['main'],
    properties: [{ displayName: 'Interval (minutes)', name: 'minutesInterval', type: 'number', default: 60 }],
    executor: intervalNode }),

  // ---- AI（codex 使 n8n 编辑器 AI 面板按官方协议归类显示）----
  def({ type: 'n8n-nodes-base.openAi', name: 'OpenAI', displayName: 'OpenAI Chat', description: '调用 OpenAI 兼容对话模型', group: ['ai'], categories: ['AI'], codex: { categories: ['AI'], subcategories: { AI: ['Language Models'] } }, icon: 'fa:microchip', inputs: ['main'], outputs: ['main'],
    properties: [
      { displayName: 'Model', name: 'model', type: 'string', default: 'gpt-4o-mini' },
      { displayName: 'Prompt', name: 'prompt', type: 'string', typeOptions: { rows: 4 }, default: '' },
    ],
    credentials: [{ name: 'openAiApi', required: true }],
    executor: openaiChatNode }),
  def({ type: 'n8n-nodes-base.embeddings', name: 'Embeddings', displayName: 'Embeddings', description: '文本向量化（需凭据）', group: ['ai'], categories: ['AI'], codex: { categories: ['AI'], subcategories: { AI: ['Embeddings'] } }, icon: 'fa:cube', inputs: ['main'], outputs: ['main'],
    properties: [
      { displayName: 'Model', name: 'model', type: 'string', default: 'text-embedding-3-small' },
      { displayName: 'API Key', name: 'apiKey', type: 'string', typeOptions: { password: true }, default: '' },
      noticeProp('向量化需要第三方 AI 凭据：当前 Worker 环境未配置时，本节点为占位（不伪造向量结果）。'),
    ],
    credentials: [{ name: 'openAiApi' }],
    executor: aiPlaceholderNode }),
  def({ type: 'n8n-nodes-base.huggingFace', name: 'Hugging Face', displayName: 'Hugging Face', description: 'HF 推理 API（需凭据）', group: ['ai'], categories: ['AI'], codex: { categories: ['AI'], subcategories: { AI: ['Language Models'] } }, icon: 'fa:smile', inputs: ['main'], outputs: ['main'],
    properties: [
      { displayName: 'Model', name: 'model', type: 'string', default: 'meta-llama/Llama-3-8b' },
      { displayName: 'API Key', name: 'apiKey', type: 'string', typeOptions: { password: true }, default: '' },
      noticeProp('HF 推理需要 API 凭据：当前 Worker 环境未配置时，本节点为占位（不伪造推理结果）。'),
    ],
    credentials: [{ name: 'huggingFaceApi', required: true }],
    executor: aiPlaceholderNode }),

  // ---- 文本处理（全部真实可执行） ----
  def({ type: 'n8n-nodes-base.replace', name: 'Text Replace', displayName: 'Text Replace', description: '文本查找替换', group: ['transform'], categories: ['Text'], icon: 'fa:search', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [{ displayName: '字段', name: 'field', type: 'string', default: 'text' }, { displayName: '查找', name: 'search', type: 'string', default: '' }, { displayName: '替换', name: 'replace', type: 'string', default: '' }],
    executor: textReplaceNode }),
  def({ type: 'n8n-nodes-base.regexExtract', name: 'Regex Extract', displayName: 'Regex Extract', description: '正则提取文本', group: ['transform'], categories: ['Text'], icon: 'fa:terminal', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [{ displayName: '字段', name: 'field', type: 'string', default: 'text' }, { displayName: 'Regex', name: 'regex', type: 'string', default: '' }],
    executor: regexExtractNode }),
  def({ type: 'n8n-nodes-base.textCase', name: 'Text Case', displayName: 'Text Case', description: '转换大小写', group: ['transform'], categories: ['Text'], icon: 'fa:font', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [
      { displayName: 'Field', name: 'field', type: 'string', default: 'text' },
      { displayName: 'Action', name: 'action', type: 'options', default: 'uppercase', options: [{ name: 'Uppercase', value: 'uppercase' }, { name: 'Lowercase', value: 'lowercase' }, { name: 'Title Case', value: 'titleCase' }] },
    ],
    executor: textCaseNode }),
  def({ type: 'n8n-nodes-base.splitOut', name: 'Text Split', displayName: 'Text Split', description: '按分隔符拆分为数组', group: ['transform'], categories: ['Text'], icon: 'fa:scissors', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [{ displayName: '分隔符', name: 'separator', type: 'string', default: ',' }],
    executor: textSplitNode }),
  def({ type: 'n8n-nodes-base.textTemplate', name: 'Text Template', displayName: 'Text Template', description: '{{ $json }} 模板插值', group: ['transform'], categories: ['Text'], icon: 'fa:paragraph', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [{ displayName: '模板', name: 'template', type: 'string', typeOptions: { rows: 5 }, default: '' }],
    executor: textTemplateNode }),
  def({ type: 'n8n-nodes-base.textTruncate', name: 'Text Truncate', displayName: 'Text Truncate', description: '按长度截断', group: ['transform'], categories: ['Text'], icon: 'fa:cut', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [{ displayName: '最大长度', name: 'length', type: 'number', default: 100 }],
    executor: textTruncateNode }),
  def({ type: 'n8n-nodes-base.textCount', name: 'Text Count', displayName: 'Text Count', description: '统计字符/单词/行数', group: ['transform'], categories: ['Text'], icon: 'fa:hashtag', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [{ displayName: 'Field', name: 'field', type: 'string', default: 'text' }],
    executor: textCountNode }),

  // ---- 列表/数据工具（全部真实可执行） ----
  def({ type: 'n8n-nodes-base.limit', name: 'Limit', displayName: 'Limit', description: '限制输出条数', group: ['transform'], categories: ['Data'], icon: 'fa:filter', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [{ displayName: '最大条数', name: 'maxItems', type: 'number', default: 10 }],
    executor: limitNode }),
  def({ type: 'n8n-nodes-base.renameKeys', name: 'Rename Keys', displayName: 'Rename Keys', description: '批量重命名字段', group: ['transform'], categories: ['Data'], icon: 'fa:pen', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [
      { displayName: 'Renaming', name: 'renaming', type: 'fixedCollection', default: {}, typeOptions: { multipleValues: true }, options: [{ name: 'renaming', displayName: 'Rename', values: [
        { displayName: 'From Key', name: 'fromKey', type: 'string', default: '' },
        { displayName: 'To Key', name: 'toKey', type: 'string', default: '' },
      ] }] },
    ],
    executor: renameKeysNode }),
  def({ type: 'n8n-nodes-base.zip', name: 'Zip', displayName: 'Zip', description: '多条输入压缩为单条对象', group: ['transform'], categories: ['Data'], icon: 'fa:archive', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [{ displayName: '字段名', name: 'field', type: 'string', default: 'items' }],
    executor: zipNode }),
  def({ type: 'n8n-nodes-base.itemLists', name: 'Item Lists', displayName: 'Item Lists', description: '把对象数组展开为多行', group: ['transform'], categories: ['Data'], icon: 'fa:list-ul', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [{ displayName: '拆分字段', name: 'fieldToSplitName', type: 'string', default: 'items' }],
    executor: itemListsNode }),
  def({ type: 'n8n-nodes-base.store', name: 'Store (KV)', displayName: 'Store (KV)', description: '读写 Cloudflare KV(CREDENTIALS)', group: ['action'], categories: ['Storage'], icon: 'fa:key', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [{ displayName: '操作', name: 'operation', type: 'string', default: 'get' }, { displayName: '键', name: 'key', type: 'string', default: '' }],
    executor: storeNode }),
  def({ type: 'n8n-nodes-base.convertToJson', name: 'Convert To JSON', displayName: 'Convert To JSON', description: 'JSON 字符串转对象并展开', group: ['transform'], categories: ['Data'], icon: 'fa:code', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [{ displayName: '源字段', name: 'dataPropertyName', type: 'string', default: 'json' }],
    executor: convertToJsonNode }),
  def({ type: 'n8n-nodes-base.joinList', name: 'Join List', displayName: 'Join List', description: '把多行对象合并为单条，按分隔符拼接字段', group: ['transform'], categories: ['Data'], icon: 'fa:arrows-alt-h', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [{ displayName: '待拼接字段', name: 'field', type: 'string', default: 'items' }, { displayName: '分隔符', name: 'separator', type: 'string', default: ',' }],
    executor: joinListNode }),
  def({ type: 'n8n-nodes-base.assign', name: 'Assign', displayName: 'Assign', description: '给每个输入项赋值变量/字段', group: ['transform'], categories: ['Data'], icon: 'fa:plus-square', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [{ displayName: 'Assignments', name: 'assignments', type: 'json', default: '[]', description: 'JSON 数组：[{ name, value }]' }],
    executor: assignNode }),

  // ---- 消息通讯 ----
  def({ type: 'n8n-nodes-base.httpSend', name: 'HTTP Send', displayName: 'HTTP Send', description: '通用 HTTP 请求发送（回调/通知）', group: ['action'], categories: ['Communications'], icon: 'fa:paper-plane', inputs: ['main'], outputs: ['main'], subcategory: SUB.CORE,
    properties: [{ displayName: 'URL', name: 'url', type: 'string', default: '', required: true }, { displayName: 'Method', name: 'method', type: 'options', options: ['GET','POST','PUT','DELETE','PATCH'].map((x)=>({name:x,value:x})) }],
    executor: httpSendNode }),
  def({ type: 'n8n-nodes-base.webhookSend', name: 'Webhook Send', displayName: 'Webhook Send', description: '发送到 Webhook 回调地址', group: ['action'], categories: ['Communications'], icon: 'fa:globe', inputs: ['main'], outputs: ['main'], subcategory: SUB.CORE,
    properties: [{ displayName: 'URL', name: 'url', type: 'string', required: true, default: '' }, { displayName: 'Payload', name: 'message', type: 'json', default: '{}' }],
    executor: webhookSendNode }),
  def({ type: 'n8n-nodes-base.sendgrid', name: 'SendGrid', displayName: 'SendGrid (Email)', description: '发送邮件（需 SendGrid API Key）', group: ['action'], categories: ['Communications'], icon: 'fa:envelope', inputs: ['main'], outputs: ['main'],
    properties: [
      { displayName: 'To', name: 'to', type: 'string', default: '' },
      { displayName: 'From', name: 'from', type: 'string', default: '' },
      { displayName: 'Subject', name: 'subject', type: 'string', default: '' },
      { displayName: 'Text', name: 'text', type: 'string', typeOptions: { rows: 4 }, default: '' },
      noticeProp('发送邮件需要 SendGrid 凭据：当前 Worker 环境未配置时，本节点为占位（不伪造发送成功）。'),
    ],
    credentials: [{ name: 'sendGridApi', required: true }],
    executor: notifyPlaceholderNode }),
  def({ type: 'n8n-nodes-base.email', name: 'Email', displayName: 'Email', description: '发送邮件（需凭据）', group: ['action'], categories: ['Communications'], icon: 'fa:envelope', inputs: ['main'], outputs: ['main'],
    properties: [
      { displayName: 'To', name: 'to', type: 'string', default: '' },
      { displayName: 'Subject', name: 'subject', type: 'string', default: '' },
      { displayName: 'Text', name: 'text', type: 'string', typeOptions: { rows: 4 }, default: '' },
      noticeProp('发送邮件需要 SMTP 凭据：当前 Worker 环境未配置时，本节点为占位（不伪造发送成功）。'),
    ],
    credentials: [{ name: 'smtp', required: true }],
    executor: notifyPlaceholderNode }),
  def({ type: 'n8n-nodes-base.slack', name: 'Slack', displayName: 'Slack', description: 'Slack 消息发送（需凭据）', group: ['action'], categories: ['Communications'], icon: 'fa:hashtag', inputs: ['main'], outputs: ['main'],
    properties: [
      { displayName: 'Channel', name: 'channel', type: 'string', default: '' },
      { displayName: 'Text', name: 'text', type: 'string', typeOptions: { rows: 4 }, default: '' },
      noticeProp('发送 Slack 消息需要 Slack API 凭据：当前 Worker 环境未配置时，本节点为占位。'),
    ],
    credentials: [{ name: 'slackApi', required: true }],
    executor: notifyPlaceholderNode }),
  def({ type: 'n8n-nodes-base.telegram', name: 'Telegram', displayName: 'Telegram', description: 'Telegram 消息（需 Bot Token）', group: ['action'], categories: ['Communications'], icon: 'fa:paper-plane', inputs: ['main'], outputs: ['main'],
    properties: [
      { displayName: 'Chat ID', name: 'chatId', type: 'string', default: '' },
      { displayName: 'Text', name: 'text', type: 'string', typeOptions: { rows: 4 }, default: '' },
      noticeProp('发送 Telegram 消息需要 Bot Token：当前 Worker 环境未配置时，本节点为占位。'),
    ],
    credentials: [{ name: 'telegramApi', required: true }],
    executor: notifyPlaceholderNode }),
  def({ type: 'n8n-nodes-base.discord', name: 'Discord', displayName: 'Discord', description: 'Discord 消息（需 Webhook）', group: ['action'], categories: ['Communications'], icon: 'fa:comments', inputs: ['main'], outputs: ['main'],
    properties: [
      { displayName: 'Webhook URL', name: 'webhookUrl', type: 'string', default: '' },
      { displayName: 'Content', name: 'content', type: 'string', typeOptions: { rows: 4 }, default: '' },
      noticeProp('发送 Discord 消息需要 Webhook URL 凭据：当前 Worker 环境未配置时，本节点为占位。'),
    ],
    credentials: [{ name: 'discordApi', required: true }],
    executor: notifyPlaceholderNode }),

  // ---- 消息自动化（Telegram / 企业微信 / 翻译，全部真实可执行） ----
  def({ type: 'n8n-nodes-base.telegramChannelReader', name: 'Telegram Channel', displayName: 'Telegram Channel', description: '抓取 t.me 公开频道最近消息（无需 token）', group: ['action'], categories: ['Communications', 'Data'], icon: 'fa:paper-plane', inputs: ['main'], outputs: ['main'],
    properties: [
      { displayName: '频道德', name: 'channel', type: 'string', default: 'FireflyLeak', required: true, description: '单个频道名(不带 @)' },
      { displayName: '频道列表', name: 'channels', type: 'json', default: '["FireflyLeak"]', description: '多个用数组；优先于单频道字段' },
      { displayName: '每条上限', name: 'limit', type: 'number', default: 3 },
    ],
    executor: telegramChannelNode }),
  def({ type: 'n8n-nodes-base.weCom', name: '企业微信 (WeChat Work)', displayName: '企业微信 Webhook', description: '推送到企业微信群机器人(需 webhook URL 含 key)', group: ['action'], categories: ['Communications'], icon: 'fa:comment', inputs: ['main'], outputs: ['main'],
    properties: [
      { displayName: 'Webhook URL', name: 'webhookUrl', type: 'string', default: '', required: true, placeholder: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...' },
      { displayName: '消息类型', name: 'msgtype', type: 'options', default: 'markdown', options: [{ name: 'Markdown', value: 'markdown' }, { name: 'Text', value: 'text' }] },
      { displayName: '自定义内容(可选)', name: 'content', type: 'string', typeOptions: { rows: 5 }, default: '', description: '留空则自动把输入整合为 markdown 列表' },
    ],
    executor: weComSendNode }),
  def({ type: 'n8n-nodes-base.translate', name: 'Translate', displayName: 'Translate', description: '翻译文本(Google 免费/OpenAI 兼容可配)', group: ['transform'], categories: ['Text'], icon: 'fa:language', inputs: ['main'], outputs: ['main'],
    properties: [
      { displayName: '引擎', name: 'engine', type: 'options', default: 'google', options: [{ name: 'Google(免费)', value: 'google' }, { name: 'OpenAI 兼容', value: 'openai' }] },
      { displayName: '目标语言', name: 'target', type: 'string', default: 'zh-CN' },
      { displayName: '文本字段', name: 'textField', type: 'string', default: 'text' },
    ],
    executor: translateNode }),

  // ---- 扩展：字段裁剪 / 文本清洗 / 数据处理（全部真实可执行） ----
  def({ type: 'n8n-nodes-base.keepFields', name: 'Pick Fields', displayName: 'Pick Fields 仅保留字段', description: '每条仅保留指定字段', group: ['transform'], categories: ['Data'], icon: 'fa:check-square', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [{ displayName: '字段列表', name: 'fields', type: 'json', default: '["id","text","ts"]', description: 'JSON 数组：只保留这些字段' }],
    executor: keepFieldsNode }),
  def({ type: 'n8n-nodes-base.dropFields', name: 'Remove Fields', displayName: 'Remove Fields 删除字段', description: '删除指定字段，其余保留', group: ['transform'], categories: ['Data'], icon: 'fa:minus-square', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [{ displayName: '字段列表', name: 'fields', type: 'json', default: '[]', description: 'JSON 数组：要删除的字段名' }],
    executor: dropFieldsNode }),
  def({ type: 'n8n-nodes-base.textTrim', name: 'Text Trim', displayName: 'Text Trim 清理文本', description: '清理首尾空白，可选压缩多余换行', group: ['transform'], categories: ['Text'], icon: 'fa:align-left', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [
      { displayName: '文本字段', name: 'field', type: 'string', default: 'text' },
      { displayName: '压缩多余空白', name: 'collapseWhitespace', type: 'boolean', default: false },
    ],
    executor: textTrimNode }),
  def({ type: 'n8n-nodes-base.textSlice', name: 'Text Slice', displayName: 'Text Slice 截取子串', description: '从指定位置截取一段文本', group: ['transform'], categories: ['Text'], icon: 'fa:cut', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [
      { displayName: '文本字段', name: 'field', type: 'string', default: 'text' },
      { displayName: '起始位置', name: 'start', type: 'number', default: 0 },
      { displayName: '截取长度(0=到末尾)', name: 'length', type: 'number', default: 0 },
    ],
    executor: textSliceNode }),
  def({ type: 'n8n-nodes-base.flatten', name: 'Flatten', displayName: 'Flatten 展开嵌套字段', description: '把嵌套对象拍平为点分字段', group: ['transform'], categories: ['Data'], icon: 'fa:expand-arrows-alt', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [
      { displayName: '源字段(空=整条)', name: 'field', type: 'string', default: '' },
      { displayName: '前缀', name: 'prefix', type: 'string', default: '' },
    ],
    executor: flattenNode }),
  def({ type: 'n8n-nodes-base.splitToItems', name: 'Split To Items', displayName: 'Split To Items 拆成多行', description: '把长文本按分隔符拆成多条数据', group: ['transform'], categories: ['Data'], icon: 'fa:columns', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [
      { displayName: '文本字段', name: 'field', type: 'string', default: 'text' },
      { displayName: '分隔符', name: 'separator', type: 'string', default: '\\n', description: '例如 \\n 换行、, 逗号' },
    ],
    executor: splitToItemsNode }),
  def({ type: 'n8n-nodes-base.addMeta', name: 'Add Metadata', displayName: 'Add ID & Timestamp', description: '为每条附加唯一 id 与时间戳', group: ['transform'], categories: ['Data'], icon: 'fa:tag', inputs: ['main'], outputs: ['main'], subcategory: SUB.DATA,
    properties: [
      { displayName: 'ID 字段名', name: 'idField', type: 'string', default: 'id' },
      { displayName: '时间戳字段名', name: 'timeField', type: 'string', default: 'ts' },
    ],
    executor: addMetaNode }),
];

export const builtinPlugin: NodePlugin = {
  id: 'n8n-nodes-base',
  label: 'n8n-nodes-base',
  description: 'mini-flow 内置基础节点（触发器/数据/流程/代码/工具）',
  isCommunity: false,
  nodes,
};

registerPlugin(builtinPlugin);