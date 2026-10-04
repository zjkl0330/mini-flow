// 第8轮：实机核验「空数组返回」在逐项模式下的行为（我独立提出的疑点，非转述）
// 契约（src/nodes/code-node.ts:126-134）：
//  - 返回「数据项数组」(元素形如 { json }) → 展开为多个 item
//  - 返回普通值数组（如 [1,2]）→ 并入当前项的 output
// 疑点：`return []` 会命中 `[].every(isItemShape) === true`（空真），走展开分支 → 丢光全部输入项，
//       而执行仍报 success。属「静默丢项」类。
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

async function run(bCode) {
  const id = 'p8-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
  await req('POST', '/rest/workflows', {
    cookie,
    body: {
      id, name: 'p8', settings: {},
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
  const r = await req('POST', `/rest/workflows/${id}/run`, { cookie, body: { data: {} } });
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
  const a = logs.find((x) => x.node_name === 'CodeA');
  const b = logs.find((x) => x.node_name === 'CodeB');
  const p = (v) => { try { return JSON.parse(v); } catch { return v; } };
  return {
    execStatus: detail?.status,
    aOut: p(a?.output_data)?.main?.length,
    bStatus: b?.status, bErr: b?.error_message,
    bOut: p(b?.output_data)?.main,
  };
}

console.log('=== 对照组：CodeB `return [1,2];`（普通值数组，契约=并入 output）===');
{
  const r = await run('return [1,2];');
  console.log('exec:', r.execStatus, '| CodeA 项数:', r.aOut, '| CodeB status:', r.bStatus, '| CodeB 项数:', r.bOut?.length);
  console.log('输出:', JSON.stringify(r.bOut));
}

console.log('\n=== 疑点组：CodeB `return [];`（空数组）===');
{
  const r = await run('return [];');
  console.log('exec:', r.execStatus, '| CodeA 项数:', r.aOut, '| CodeB status:', r.bStatus, '| CodeB 项数:', r.bOut?.length);
  console.log('输出:', JSON.stringify(r.bOut));
  console.log('判定：CodeB 项数 =', r.bOut?.length, '→ ', r.bOut?.length === 3 ? '契约一致（并入 output）' : (r.bOut?.length === 0 ? '丢光全部输入项（空真 bug）' : '其它'));
}

console.log('\n=== 旁证：CodeB `return json.list.filter(x => x > 99);` 得到空数组（真实业务写法）===');
{
  const r = await run('return json.n > 99 ? [1] : [];');
  console.log('exec:', r.execStatus, '| CodeB status:', r.bStatus, '| CodeB 项数:', r.bOut?.length);
  console.log('输出:', JSON.stringify(r.bOut));
}
