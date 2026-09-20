-- ============================================================
-- mini-flow 增量迁移 01（仅对「已部署/已建库」的 D1 执行）
-- ============================================================
-- 适用前提：该库此前是用不含新列的旧 schema.sql 建立的。
--   * 新库：直接用 schema.sql 建库（其中 executions 已含 retry_of / retry_success_id），
--     不要再执行本文件（否则 ALTER TABLE 会因「列已存在」报错）。
--   * 已建库：执行本文件补齐新列与新表。
--
-- 执行命令（本地）：wrangler d1 execute mini-flow-db --file=migrations/increment-01.sql
-- 执行命令（远端）：wrangler d1 execute mini-flow-db --remote --file=migrations/increment-01.sql
--
-- 幂等性说明：SQLite 的 ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS，
--   重复执行会报 "duplicate column name"，属预期（本文件对已建库一次性执行）。
--   建表/建索引均带 IF NOT EXISTS，可安全重复执行。
-- ============================================================

-- 1) executions 扩展（REQ-15 重试关联）
ALTER TABLE executions ADD COLUMN retry_of TEXT;
ALTER TABLE executions ADD COLUMN retry_success_id TEXT;

-- 2) 标签（REQ-27）
CREATE TABLE IF NOT EXISTS tags (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name       TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workflow_tags (
  workflow_id TEXT NOT NULL,
  tag_id      TEXT NOT NULL,
  PRIMARY KEY (workflow_id, tag_id),
  FOREIGN KEY (workflow_id) REFERENCES workflows(id),
  FOREIGN KEY (tag_id) REFERENCES tags(id)
);

-- 3) 社区节点安装登记（REQ-32；元数据级，不执行外部代码）
CREATE TABLE IF NOT EXISTS community_nodes (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name         TEXT NOT NULL UNIQUE,
  display_name TEXT,
  version      TEXT,
  description  TEXT,
  nodes_json   TEXT,
  installed_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 4) 索引
CREATE INDEX IF NOT EXISTS idx_executions_retry_of ON executions(retry_of);
CREATE INDEX IF NOT EXISTS idx_workflow_tags_tag ON workflow_tags(tag_id);
