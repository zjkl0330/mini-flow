// tests/unit/http-request.test.ts
// REQ-11：HTTP 节点非 2xx 默认失败单测。
// 通过替换全局 fetch 注入可控响应，验证：
//   * 默认（未开启忽略开关）→ 非 2xx 抛错；
//   * 显式 ignoreHttpStatusErrors=true（或等价逃生开关）→ 返回响应数据。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { httpRequestNode } from '../../src/nodes/http-request';
import type { NodeExecutionContext } from '../../src/types';

// 构造最小执行上下文（executor 仅读取 node.parameters 与 inputData）
function makeCtx(parameters: Record<string, unknown>): NodeExecutionContext {
  return {
    workflow: { name: 'w', nodes: [], connections: {} },
    executionId: 'e1',
    node: { type: 'n8n-nodes-base.httpRequest', name: 'HTTP', parameters, typeVersion: 1, position: [0, 0] },
    inputData: { main: [{ json: {} }] },
    env: {} as never,
    log: () => {},
  } as unknown as NodeExecutionContext;
}

async function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

test('HTTP 节点：非 2xx 默认抛错（回归：曾把 5xx 页当成功数据）', async () => {
  await withFetch(
    (async () => new Response('server boom', { status: 500 })) as unknown as typeof fetch,
    async () => {
      await assert.rejects(
        () => httpRequestNode.execute(makeCtx({ method: 'GET', url: 'https://example.test/x' })),
        /HTTP 500/,
      );
    },
  );
});

test('HTTP 节点：ignoreHttpStatusErrors=true 时返回响应数据（逃生开关）', async () => {
  await withFetch(
    (async () => new Response(JSON.stringify({ ok: false }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch,
    async () => {
      const out = await httpRequestNode.execute(makeCtx({
        method: 'GET', url: 'https://example.test/x', ignoreHttpStatusErrors: true,
      }));
      assert.equal(out.main[0].json.statusCode, 503);
      assert.equal((out.main[0].json.body as { ok: boolean }).ok, false);
    },
  );
});

test('HTTP 节点：2xx 正常返回解析后的响应体 + statusCode', async () => {
  await withFetch(
    (async () => new Response(JSON.stringify({ value: 42 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    })) as unknown as typeof fetch,
    async () => {
      const out = await httpRequestNode.execute(makeCtx({ method: 'GET', url: 'https://example.test/x' }));
      assert.equal(out.main[0].json.statusCode, 200);
      assert.equal((out.main[0].json as { value: number }).value, 42);
    },
  );
});

test('HTTP 节点：网络层错误无条件抛错（既有 REQ-10 语义保持）', async () => {
  await withFetch(
    (async () => { throw new Error('dns failure'); }) as unknown as typeof fetch,
    async () => {
      await assert.rejects(
        () => httpRequestNode.execute(makeCtx({ method: 'GET', url: 'https://nope.test/x' })),
        /HTTP 请求失败/,
      );
    },
  );
});
