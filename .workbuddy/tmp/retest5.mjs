// 第5轮：修正构造 —— 让上游真正产出 3 项，再验 F1 与多输入项 E2E
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

async function run(aCode, bCode, input = { seed: 0 }) {
  const id = 'p5-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  await req('POST', '/rest/workflows', {
    cookie,
    body: {
      id, name: 'p5', settings: {},
      nodes: [
        { id: 's', name: 'Start', type: 'n8n-nodes-base.start', typeVersion: 1, position: [0, 0], parameters: {} },
        { id: 'a', name: 'CodeA', type: 'n8n-nodes-base.code', typeVersion: 1, position: [200, 0], parameters: { javascriptCode: aCode } },
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
  const find = (n) => (raw?.json?.data?.nodeLogs || []).find((x) => x.node_name === n);
  const parse = (n) => { const l = find(n); if (!l) return null; try { return JSON.parse(l.output_data); } catch { return l.output_data; } };
  return { status: detail?.status, aOut: parse('CodeA'), bOut: parse('CodeB'), bIn: (() => { const l = find('CodeB'); if (!l) return null; try { return JSON.parse(l.input_data); } catch { return l.input_data; } })() };
}

// 让 CodeA 走整批路径（代码含 items）并产出 3 项
const A_THREE_ITEMS = 'return items.length >= 0 ? [1,2,3].map(x => ({ json: { n: x } })) : []';

console.log('=== 前置：确认 CodeA 真能产出 3 项（多输入项 live E2E）===');
{
  const r = await run(A_THREE_ITEMS, 'return n * 2;');
  console.log('execStatus:', r.status);
  console.log('CodeA 项数:', r.aOut?.main?.length, JSON.stringify(r.aOut?.main));
  console.log('CodeB 输入:', JSON.stringify(r.bIn));
  console.log('CodeB 项数:', r.bOut?.main?.length, JSON.stringify(r.bOut?.main));
  console.log('期望: CodeB 3 项 [{"n":1,"output":2},{"n":2,"output":4},{"n":3,"output":6}]');
}

console.log('\n=== F1 复现：CodeB = `return json.items;`（字段访问，却被误判为内置 items）===');
{
  const A_ITEMS = 'return items.length >= 0 ? [1,2,3].map(x => ({ json: { items: [x, x] } })) : []';
  const r = await run(A_ITEMS, 'return json.items;');
  console.log('execStatus:', r.status);
  console.log('CodeA 项数:', r.aOut?.main?.length, JSON.stringify(r.aOut?.main));
  console.log('CodeB 输入:', JSON.stringify(r.bIn));
  console.log('CodeB 项数:', r.bOut?.main?.length, JSON.stringify(r.bOut?.main));
  console.log('期望(逐项): 3 项，每项 {"items":[x,x],"output":[x,x]}');
}

console.log('\n=== 对照：CodeB 无 items 字样时（`return n * 2;`）路由正确 ===');
console.log('（见上方「前置」段：应为 3 项）');
