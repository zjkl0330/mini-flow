// tests/integration/schema-migration.test.ts
// REQ-15 / REQ-27 / REQ-32 的「两条建库路径一致性」验证：
//   路径 A（新库）：直接执行 schema.sql
//   路径 B（旧库升级）：执行「改动前」的 schema.sql，再执行 migrations/increment-01.sql
// 断言两条路径得到一致的最终结构（表集合 / executions 列 / 索引集合），
// 否则线上（旧库跑迁移）与本地（新库跑 schema）会结构性分叉。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const NEW_SCHEMA = readFileSync(resolve(ROOT, 'schema.sql'), 'utf8');
const MIGRATION = readFileSync(resolve(ROOT, 'migrations/increment-01.sql'), 'utf8');
// 「改动前」的基线 schema（本次增量提交之前的最后一个版本）
const OLD_SCHEMA = execSync('git show 31dec73:schema.sql', { cwd: ROOT, encoding: 'utf8' });

function tablesOf(db: DatabaseSync): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}
function indexesOf(db: DatabaseSync): string[] {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}
function columnsOf(db: DatabaseSync, table: string): Array<{ name: string; type: string; notnull: number; dflt: unknown }> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>;
  return rows.map((r) => ({ name: r.name, type: r.type, notnull: r.notnull, dflt: r.dflt_value }));
}

function newDb(sql: string): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(sql);
  return db;
}

test('迁移一致性：schema.sql（新库）与 旧schema+increment-01.sql（升级库）最终结构一致', () => {
  const fresh = newDb(NEW_SCHEMA);

  const upgraded = new DatabaseSync(':memory:');
  upgraded.exec('PRAGMA foreign_keys = ON;');
  upgraded.exec(OLD_SCHEMA);   // 改动前基线
  upgraded.exec(MIGRATION);    // 增量迁移

  // 1) 表集合
  assert.deepEqual(tablesOf(upgraded), tablesOf(fresh), '两条路径的表集合应一致');
  for (const t of ['tags', 'workflow_tags', 'community_nodes']) {
    assert.ok(tablesOf(fresh).includes(t), `新库应含表 ${t}`);
    assert.ok(tablesOf(upgraded).includes(t), `升级库应含表 ${t}`);
  }

  // 2) executions 列（名称 + 类型 + notnull + 默认值）
  const freshCols = columnsOf(fresh, 'executions');
  const upCols = columnsOf(upgraded, 'executions');
  assert.deepEqual(upCols.map((c) => [c.name, c.type, c.notnull, c.dflt]), freshCols.map((c) => [c.name, c.type, c.notnull, c.dflt]), 'executions 列定义应一致');
  const names = freshCols.map((c) => c.name);
  assert.ok(names.includes('retry_of') && names.includes('retry_success_id'), '必须含重试关联两列');

  // 3) 索引集合
  assert.deepEqual(indexesOf(upgraded), indexesOf(fresh), '两条路径的索引集合应一致');
  assert.ok(indexesOf(fresh).includes('idx_executions_retry_of'));
  assert.ok(indexesOf(fresh).includes('idx_workflow_tags_tag'));

  fresh.close();
  upgraded.close();
});

test('迁移一致性：executions 新列可实际读写（真实 SQLite 行为）', () => {
  const upgraded = new DatabaseSync(':memory:');
  upgraded.exec('PRAGMA foreign_keys = ON;');
  upgraded.exec(OLD_SCHEMA);
  upgraded.exec(MIGRATION);
  upgraded.exec("INSERT INTO workflows (id,name,nodes,connections) VALUES ('w1','WF','[]','{}')");
  upgraded.exec("INSERT INTO executions (id,workflow_id,retry_of,retry_success_id) VALUES ('e1','w1','e0','e2')");
  const row = upgraded.prepare("SELECT retry_of, retry_success_id FROM executions WHERE id='e1'").get() as { retry_of: string; retry_success_id: string };
  assert.equal(row.retry_of, 'e0');
  assert.equal(row.retry_success_id, 'e2');
  upgraded.close();
});
