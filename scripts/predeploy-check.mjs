#!/usr/bin/env node
// scripts/predeploy-check.mjs
// 部署前自检门禁（SEC-3）：挂到 package.json 的 predeploy，`npm run deploy` 时自动执行。
//
// 目的：把「部署后才发现」的问题提前到部署前。四类检查：
//   1) 结构：wrangler.jsonc 的 D1 / KV / DO / Workflows / Assets 绑定齐全，且 dist 已构建；
//   2) 安全：确认 ADMIN_PASSWORD / SESSION_SECRET 已作为 Worker Secret 配置
//      （本脚本无法读取 Secret，需运维用 MINI_FLOW_SECRETS_CONFIRMED=1 显式确认）；
//   3) 卫生：源码不得出现「无条件生效」的回退口令，.dev.vars 必须被 .gitignore 忽略；
//   4) 迁移：migrations/*.sql 新增的表/列必须同步进 schema.sql。
//
// 退出码：0 = 全部通过；1 = 存在阻断项（部署应中止）。
// 用法：node scripts/predeploy-check.mjs     （或 npm run deploy 时自动触发）

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];
const passes = [];

const fail = (msg) => errors.push(msg);
const warn = (msg) => warnings.push(msg);
const pass = (msg) => passes.push(msg);

// ---- 工具：读取 wrangler.jsonc（含 // 注释，标准 JSON.parse 会失败） ----
function readWranglerConfig() {
  const file = join(root, 'wrangler.jsonc');
  if (!existsSync(file)) {
    fail('缺少 wrangler.jsonc');
    return null;
  }
  const raw = readFileSync(file, 'utf8')
    // 去掉行注释（本文件不含字符串内 // 的场景）
    .replace(/^\s*\/\/.*$/gm, '')
    // 去掉尾随逗号
    .replace(/,(\s*[}\]])/g, '$1');
  try {
    return JSON.parse(raw);
  } catch (e) {
    fail(`wrangler.jsonc 解析失败：${e.message}`);
    return null;
  }
}

// ---- 工具：递归收集文件 ----
function walk(dir, filter, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, filter, out);
    else if (filter(full)) out.push(full);
  }
  return out;
}

// ---- 1) 结构检查 ----
const config = readWranglerConfig();
if (config) {
  const d1Names = (config.d1_databases ?? []).map((d) => d.binding);
  if (!d1Names.includes('DB')) fail('wrangler.jsonc 缺少 d1_databases 绑定 "DB"');
  else pass('D1 绑定 DB 存在');

  const kvNames = (config.kv_namespaces ?? []).map((k) => k.binding);
  if (!kvNames.includes('CREDENTIALS')) fail('wrangler.jsonc 缺少 kv_namespaces 绑定 "CREDENTIALS"');
  else pass('KV 绑定 CREDENTIALS 存在');

  const doNames = (config.durable_objects?.bindings ?? []).map((b) => b.name);
  if (!doNames.includes('PUSH')) fail('wrangler.jsonc 缺少 durable_objects 绑定 "PUSH"');
  else pass('DO 绑定 PUSH 存在');

  const wfNames = (config.workflows ?? []).map((w) => w.binding);
  if (!wfNames.includes('FLOW_ENGINE')) fail('wrangler.jsonc 缺少 workflows 绑定 "FLOW_ENGINE"');
  else pass('Workflows 绑定 FLOW_ENGINE 存在');

  const assetsDir = config.assets?.directory ? resolve(root, config.assets.directory) : '';
  if (!assetsDir) {
    fail('wrangler.jsonc 未配置 assets.directory');
  } else if (!existsSync(assetsDir)) {
    fail(`静态资源目录不存在：${config.assets.directory}（请先构建 frontend/dist）`);
  } else if (!existsSync(join(assetsDir, 'index.html'))) {
    fail(`${config.assets.directory}/index.html 不存在，SPA 将 404`);
  } else {
    pass(`静态资源就绪：${config.assets.directory}/index.html`);
  }
}

// ---- 2) 安全：Secret 确认 ----
if (process.env.MINI_FLOW_SECRETS_CONFIRMED === '1') {
  pass('已显式确认 ADMIN_PASSWORD / SESSION_SECRET 已配置为 Worker Secret');
} else {
  fail(
    '未确认 Worker Secret 配置。生产实例必须执行：\n'
    + '      wrangler secret put ADMIN_PASSWORD      # >= 8 位\n'
    + '      wrangler secret put SESSION_SECRET      # >= 16 位\n'
    + '    确认已配置后用 MINI_FLOW_SECRETS_CONFIRMED=1 npm run deploy 重新部署。\n'
    + '    （未配置时实例会「失败关闭」：/rest/login 返回 503，不会用默认口令放行）',
  );
}

// ---- 3) 卫生：回退口令与 .dev.vars ----
const authFile = join(root, 'src/n8n/auth.ts');
if (!existsSync(authFile)) {
  fail('缺少 src/n8n/auth.ts');
} else {
  const authSrc = readFileSync(authFile, 'utf8');
  if (!/export function resolveCredentials/.test(authSrc)) {
    fail('src/n8n/auth.ts 未找到 resolveCredentials —— 凭据守卫可能被移除');
  } else if (!/DEV_ENVIRONMENTS\.has\(envName\)/.test(authSrc)) {
    fail('src/n8n/auth.ts 的 resolveCredentials 未按 ENVIRONMENT 白名单判定，回退口令可能在生产生效');
  } else {
    pass('凭据守卫在位：回退口令仅在显式开发环境生效');
  }
  // 回退口令只应出现在 auth.ts 中，且必须由守卫包裹
  const suspicious = walk(join(root, 'src'), (f) => f.endsWith('.ts'))
    .filter((f) => f !== authFile && readFileSync(f, 'utf8').includes('mini-flow-demo-password'));
  if (suspicious.length) {
    fail(`回退口令出现在守卫之外的文件：${suspicious.map((f) => relative(root, f)).join(', ')}`);
  } else {
    pass('回退口令未扩散到其它源文件');
  }
}

const gitignore = join(root, '.gitignore');
if (!existsSync(gitignore)) {
  fail('缺少 .gitignore');
} else {
  const ig = readFileSync(gitignore, 'utf8');
  if (!/^\.dev\.vars\s*$/m.test(ig)) fail('.gitignore 未忽略 .dev.vars —— 本地密钥可能被提交');
  else pass('.gitignore 已忽略 .dev.vars');
}

if (existsSync(join(root, '.dev.vars'))) {
  warn('检测到本地 .dev.vars（正常，已被忽略）；确认其中不含生产凭据');
}

// ---- 4) 迁移与 schema 一致性 ----
const schemaPath = join(root, 'schema.sql');
if (!existsSync(schemaPath)) {
  fail('缺少 schema.sql');
} else {
  const schema = readFileSync(schemaPath, 'utf8');
  const migrationsDir = join(root, 'migrations');
  const migrationFiles = existsSync(migrationsDir)
    ? readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
    : [];

  const tables = (sql) => new Set([...sql.matchAll(/CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)].map((m) => m[1].toLowerCase()));
  const schemaTables = tables(schema);

  const missingTables = [];
  for (const f of migrationFiles) {
    const sql = readFileSync(join(migrationsDir, f), 'utf8');
    for (const t of tables(sql)) if (!schemaTables.has(t)) missingTables.push(`${f}: 表 ${t}`);
  }
  if (missingTables.length) {
    fail(`下列迁移对象未同步进 schema.sql：\n      ${missingTables.join('\n      ')}`);
  } else if (migrationFiles.length) {
    pass(`迁移与 schema 表集合一致（${migrationFiles.length} 个迁移文件）`);
  }

  // 关键扩展列必须两处都有（防「本地库有、全新库没有」的漂移）
  const mustHaveColumns = ['retry_of', 'retry_success_id'];
  const absent = mustHaveColumns.filter((c) => !schema.includes(c));
  if (absent.length) fail(`schema.sql 缺少扩展列：${absent.join(', ')}`);
  else pass('executions 扩展列（retry_of / retry_success_id）在位');
}

// ---- 汇总输出 ----
console.log('\n=== mini-flow 部署前自检 ===\n');
for (const p of passes) console.log(`  [通过] ${p}`);
for (const w of warnings) console.log(`  [警告] ${w}`);
for (const e of errors) console.log(`  [阻断] ${e}`);

const blocking = errors.length;
console.log(
  `\n结果：通过 ${passes.length} / 警告 ${warnings.length} / 阻断 ${blocking}\n`,
);

if (blocking > 0) {
  console.error('自检未通过，已中止部署。修复上述「阻断」项后重试。');
  process.exit(1);
}
console.log('自检通过，可继续部署。');
