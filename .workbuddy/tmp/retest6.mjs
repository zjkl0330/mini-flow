// 第6轮：实机确认派单第 4 项（数据项数组展开）与第 5 项（简写属性提示）
const BASE = 'http://127.0.0.1:8787';
const PWD = 'mini-flow-local-dev-password';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function req(method, path, { cookie, body } = {}) {
  const h = {};
  if (cookie) h.cookie = cookie;
  let payload;
  if (body !== undefined) { h['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: res.status, text, json, headers: res.headers };
}
const login = await req('POST', '/rest/login', { body: { emailOrLdapLoginId: 'admin@example.com', password: PWD } });
const cookie = (login.headers.get('set-cookie') || '').split(';')[0];

async function run(bCode, input = { seed: 0 }) {
  const id = 'p6-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  await req('POST', '/rest/workflows', {
    cookie,
    body: {
      id, name: 'p6', settings: {},
      nodes: [
        { id: 's', name: 'Start', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'a', name: 'CodeA', type: 'n8n-nodes-base.code', typeVersion: 1, position: [200, 0], parameters: { javascriptCode: 'return items.length >= 0 ? [1,2,3].map(x => ({ json: { n: x } })) : []' } },
        { id: 'b', name: 'CodeB', type: 'n8n-nodes-base.code', typeVersion: 1, position: [400, 0], parameters: { javascriptCode: bCode } },
      ],
      connections: {
        Start: { main: [[{ node: 'CodeA', type: 'main', index: 0 }]] },
        CodeA: { main: [[{ node: 'CodeB', type: 'main', index: 0 }]] },
      },
    },
  });
  const r = await req('POST', `/rest/workflows/${id}/run`, { cookie, body: { data: input } });
  const eid = r.json?.data?.executionId;
  let raw, detail;
  const t0 = Date.now();
  while (Date.now() - t0 < 12000) {
    raw = await req('GET', `/rest/executions/_debug/${eid}/raw`, { cookie });
    const d = await req('GET', `/rest/executions/${eid}`, { cookie });
    detail = d.json?.data;
    if (detail?.finished) break;
    await sleep(600);
  }
  await req('DELETE', `/rest/workflows/${id}`, { cookie });
  const logs = raw?.json?.data?.nodeLogs || [];
  const b = logs.find((x) => x.node_name === 'CodeB');
  const p = (v) => { try { return JSON.parse(v); } catch { return v; } };
  return { execStatus: detail?.status, bStatus: b?.status, bErr: b?.error_message, bOut: p(b?.output_data), detailErr: detail?.error?.message };
}

console.log('=== 第4项：CodeB `return [1,2,3].map(x => ({ json: { v: x } }))`（不含 items 字样）===');
{
  const r = await run('return [1,2,3].map(x => ({ json: { v: x } }))');
  console.log('execStatus:', r.execStatus, '| CodeB status:', r.bStatus);
  console.log('CodeB 项数:', r.bOut?.main?.length, JSON.stringify(r.bOut?.main));
  console.log('期望: 3 输入 × 3 数据项 = 9 项（历史行为为 3 项且各含 output:[...]）');
}

console.log('\n=== 第4项对照：普通值数组 `return [1,2]`（应维持并入 output，不展开）===');
{
  const r = await run('return [1,2];');
  console.log('execStatus:', r.execStatus, '| CodeB status:', r.bStatus);
  console.log('CodeB 项数:', r.bOut?.main?.length, JSON.stringify(r.bOut?.main));
  console.log('期望: 3 项，各含 output:[1,2]');
}

console.log('\n=== 第5项：CodeB `return { idx };`（简写属性，应显式失败）===');
{
  const r = await run('return { idx };');
  console.log('execStatus:', r.execStatus, '| CodeB status:', r.bStatus);
  console.log('error_message:', (r.bErr || '').slice(0, 300));
  console.log('含「简写」?', /简写/.test(r.bErr || ''), '| 含 { idx: idx } ?', (r.bErr || '').includes('{ idx: idx }'));
  console.log('detail.error:', (r.detailErr || '').slice(0, 200));
}

console.log('\n=== 回归：CodeB `return n * 2;`（标量，应维持 output）===');
{
  const r = await run('return n * 2;');
  console.log('execStatus:', r.execStatus, '| CodeB 项数:', r.bOut?.main?.length, JSON.stringify(r.bOut?.main));
  console.log('期望: 3 项 [{"n":1,"output":2},{"n":2,"output":4},{"n":3,"output":6}]');
}
