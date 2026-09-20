// tests/helpers/d1.ts
// D1Database 兼容垫片：基于 Node 内置 node:sqlite 实现真实 SQLite 执行。
// 目的：让「离线、确定性、无网络」的测试能够真正跑通项目里的 SQL（含 ON CONFLICT / datetime('now') /
// 外键 / 索引），而不是用手写 SQL 解析器假实现（后者会掩盖真实缺陷）。
// 仅实现项目实际用到的 D1 子集：prepare / bind / run / all / first / batch / exec。
import { DatabaseSync } from 'node:sqlite';

type Row = Record<string, unknown>;

// node:sqlite 只接受 null | number | bigint | string | Uint8Array；
// D1 语义允许 boolean / undefined / 对象，这里统一归一化，避免绑定期抛错。
function toBindable(v: unknown): null | number | bigint | string | Uint8Array {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return v;
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint' || typeof v === 'string') return v;
  return String(v);
}

export interface D1RunResult {
  success: true;
  meta: { changes: number; last_row_id: number; duration: number };
}
export interface D1AllResult<T> {
  success: true;
  results: T[];
  meta: Record<string, unknown>;
}

class FakeStatement {
  constructor(
    private readonly db: DatabaseSync,
    private readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}

  bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.db, this.sql, args);
  }

  async first<T = Row>(colName?: string): Promise<T | null> {
    const row = this.db.prepare(this.sql).get(...this.params.map(toBindable)) as Row | undefined;
    if (row === undefined) return null;
    return (colName ? row[colName] : row) as T;
  }

  async all<T = Row>(): Promise<D1AllResult<T>> {
    const results = this.db.prepare(this.sql).all(...this.params.map(toBindable)) as T[];
    return { success: true, results, meta: {} };
  }

  async run(): Promise<D1RunResult> {
    const info = this.db.prepare(this.sql).run(...this.params.map(toBindable));
    return {
      success: true,
      meta: {
        changes: Number(info.changes ?? 0),
        last_row_id: Number(info.lastInsertRowid ?? 0),
        duration: 0,
      },
    };
  }

  async raw<T = unknown[]>(): Promise<T[]> {
    const rows = this.db.prepare(this.sql).all(...this.params.map(toBindable)) as Row[];
    return rows.map((r) => Object.values(r)) as T[];
  }
}

export class FakeD1 {
  readonly sqlite: DatabaseSync;

  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys = ON;');
  }

  exec(sql: string): void {
    this.sqlite.exec(sql);
  }

  prepare(sql: string): FakeStatement {
    return new FakeStatement(this.sqlite, sql);
  }

  // D1 batch：按顺序在同一隔离环境内执行，返回每个语句的结果。
  // 有意不做隐式事务回滚（D1 语义），但保持顺序与返回值形状一致。
  async batch(statements: FakeStatement[]): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const s of statements) out.push(await s.run());
    return out;
  }

  async exec_(sql: string): Promise<{ count: number; duration: number }> {
    this.sqlite.exec(sql);
    return { count: 0, duration: 0 };
  }

  close(): void {
    this.sqlite.close();
  }
}

// 载入项目真实 schema（含表、索引、默认项目种子）
export function createD1(schemaSql: string): FakeD1 {
  const db = new FakeD1();
  db.exec(schemaSql);
  return db;
}
