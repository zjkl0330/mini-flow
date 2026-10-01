-- ============================================================
-- Migration: increment-01
-- 仅对已部署 D1 执行；新库直接用 schema.sql
-- 新增列 + 新表（REQ-15, REQ-27, REQ-32）
-- ============================================================

-- 1) executions 扩展（REQ-15）
ALTER TABLE executions ADD COLUMN retry_of TEXT;
ALTER TABLE executions ADD COLUMN retry_success_id TEXT;
CREATE INDEX IF NOT EXISTS idx_executions_retry_of ON executions(retry_of);

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

CREATE INDEX IF NOT EXISTS idx_workflow_tags_tag ON workflow_tags(tag_id);

-- 3) 社区节点安装登记（REQ-32；元数据级）
CREATE TABLE IF NOT EXISTS community_nodes (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name         TEXT NOT NULL UNIQUE,
  display_name TEXT,
  version      TEXT,
  description  TEXT,
  nodes_json   TEXT,
  installed_at TEXT NOT NULL DEFAULT (datetime('now'))
);
