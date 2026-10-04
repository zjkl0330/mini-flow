// 真实端到端验证：对本地 wrangler dev（127.0.0.1:8787）实机复测本轮 10 项需求。
// 仅用于交付验证，不属于产品代码。
const B = 'http://127.0.0.1:8787';
let cookie = '';

const out = [];
const log = (...a) => { const s = a.join(' '); out.push(s); console.log(s); };

async function req(method, path, body, opts = {}) {
  const headers = { 'User-Agent': 'e2e-probe', ...(opts.headers || {}) };
  if (cookie && !opts.noAuth) headers.Cookie = cookie;
  let payload;
  if (body !== undefined) {
    if (typeof body === 'string') { payload = body; headers['Content-Type'] = opts.ct || 'application/x-www-form-urlencoded'; }
    else { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  }
  const res = await fetch(B + path, { method, headers, body: payload, redirect: 'manual' });
  const ct = res.headers.get('content-type') || '';
  let data;
  const text = await res.text();
  if (ct.includes('json')) { try { data = JSON.parse(text); } catch { data = text.slice(0, 150); } }
  else data = text.slice(0, 150);
  return { status: res.status, ct, data, res };
}

// 1) 登录
{
  const r = await req('POST', '/rest/login', { email: 'admin@example.com', password: 'mini-flow-demo-password' }, { noAuth: true });
  const sc = r.res.headers.get('set-cookie') || '';
  const m = /n8n-auth=([^;]+)/.exec(sc);
  cookie = m ? `n8n-auth=${m[1]}` : '';
  log(`[01 登录] status=${r.status} cookie=${cookie ? 'OK(3段=' + (decodeURIComponent(m[1]).split('.').length === 3) + ')' : 'FAIL'} secure=${/Secure/i.test(sc)}`);
}

// 2) 错误口令 / 不存在用户
{
  const a = await req('POST', '/rest/login', { email: 'admin@example.com', password: 'wrong' }, { noAuth: true });
  const b = await req('POST', '/rest/login', { email: 'nobody@x.test', password: 'x' }, { noAuth: true });
  log(`[02 鉴权] 错口令=${a.status} 不存在用户=${b.status} （期望 401/401）`);
}

// 3) 节点参数 schema
{
  const r = await req('GET', '/rest/node-types');
  const defs = r.data?.data ?? [];
  const empty = defs.filter((d) => !Array.isArray(d.properties) || d.properties.length === 0);
  const withCred = defs.filter((d) => Array.isArray(d.credentials) && d.credentials.length > 0);
  log(`[03 node-types] status=${r.status} 总数=${defs.length} 空参数=${empty.length} 声明凭据的节点=${withCred.length}`);
  if (empty.length) log('   空参数: ' + empty.map((x) => x.name).join(','));
  // 凭据名必须在 credential-types 中可解析
  const ct = await req('GET', '/rest/credential-types');
  const known = new Set((ct.data?.data ?? []).map((t) => t.name));
  const bad = [];
  for (const d of withCred) for (const c of d.credentials) if (!known.has(c.name)) bad.push(`${d.name}->${c.name}`);
  log(`[03b 凭据闭环] credential-types=${known.size} 个；无法解析的声明=${bad.length}${bad.length ? ' : ' + bad.join(',') : ''}`);
}

// 4) insights / tags / community
{
  for (const p of ['/rest/insights/summary', '/rest/insights/by-workflow', '/rest/insights/by-time', '/rest/insights/by-mode']) {
    const r = await req('GET', p);
    log(`[04 insights] ${p} -> ${r.status}`);
  }
  const c = await req('POST', '/rest/tags', { name: 'e2e-tag' });
  const l = await req('GET', '/rest/tags');
  const dup = await req('POST', '/rest/tags', { name: 'e2e-tag' });
  const tagId = c.data?.data?.id;
  const pt = tagId ? await req('PATCH', `/rest/tags/${tagId}`, { name: 'e2e-tag-renamed' }) : { status: 'skip' };
  const dt = tagId ? await req('DELETE', `/rest/tags/${tagId}`) : { status: 'skip' };
  log(`[05 tags] POST=${c.status} GET=${l.status}(n=${(l.data?.data ?? []).length}) 重名=${dup.status} PATCH=${pt.status} DELETE=${dt.status}`);
  const ic = await req('POST', '/rest/community-nodes', { name: 'n8n-nodes-e2e', version: '1.0.0', displayName: 'E2E Pack', nodes: [{ type: 'x.y', name: 'Y' }] });
  const il = await req('GET', '/rest/community-nodes');
  const pl = await req('GET', '/rest/plugins');
  const found = (pl.data?.data ?? []).find((x) => x.id === 'n8n-nodes-e2e');
  log(`[06 community] POST=${ic.status} GET=${il.status}(n=${(il.data?.data ?? []).length}) /rest/plugins 含社区包=${!!found} isCommunity=${found?.isCommunity}`);
}

// 5) 真实 Webhook 触发端到端
let wfId;
{
  const wf = {
    name: 'e2e-webhook-flow',
    nodes: [
      { parameters: { path: 'e2e-hook', httpMethod: 'POST', responseMode: 'onReceived' }, type: 'n8n-nodes-base.webhook', typeVersion: 1, position: [0, 0], id: 'wh1', name: 'Webhook' },
      { parameters: { notice: 'x' }, type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [220, 0], id: 'n1', name: 'NoOp' },
    ],
    connections: { Webhook: { main: [[{ node: 'NoOp', type: 'main', index: 0 }]] } },
    settings: {},
  };
  const c = await req('POST', '/rest/workflows', wf);
  wfId = c.data?.data?.id;
  const act = wfId ? await req('POST', `/rest/workflows/${wfId}/activate`, {}) : { status: 'skip' };
  log(`[07 建流+激活] create=${c.status} id=${wfId} activate=${act.status} active=${act.data?.data?.active}`);

  const before = await req('GET', '/rest/executions?limit=50');
  const nBefore = before.data?.data?.results?.length ?? 0;

  const hook = await req('POST', '/webhook/e2e-hook', { hello: 'e2e' }, { noAuth: true });
  log(`[08 webhook 命中] POST /webhook/e2e-hook -> ${hook.status} ct=${hook.ct} body=${JSON.stringify(hook.data).slice(0, 120)}`);

  const miss = await req('POST', '/webhook/does-not-exist-xyz', {}, { noAuth: true });
  log(`[09 webhook 未匹配] -> ${miss.status} ct=${miss.ct} body=${JSON.stringify(miss.data).slice(0, 120)}`);

  await new Promise((r) => setTimeout(r, 6000));
  const after = await req('GET', '/rest/executions?limit=50');
  const results = after.data?.data?.results ?? [];
  const nAfter = results.length;
  const webhookExec = results.find((e) => e.mode === 'webhook' || e.workflowId === wfId);
  log(`[10 执行落库] before=${nBefore} after=${nAfter} 新增=${nAfter - nBefore} 最新mode=${results[0]?.mode} status=${results[0]?.status} wf=${results[0]?.workflowName}`);
  if (webhookExec) log(`   命中执行: id=${webhookExec.id} mode=${webhookExec.mode} status=${webhookExec.status}`);
}

// 6) 导出 / 导入 / retry
{
  const ex = await req('GET', `/rest/workflows/${wfId}/export`);
  log(`[11 export] status=${ex.status} disp=${ex.res.headers.get('content-disposition')} keys=${ex.data && typeof ex.data === 'object' ? Object.keys(ex.data).slice(0, 8).join(',') : ex.data}`);
  const im = await req('POST', '/rest/workflows/import', { name: 'e2e-imported', nodes: [], connections: {}, settings: {} });
  log(`[12 import] status=${im.status} id=${im.data?.data?.id}`);

  const list = await req('GET', '/rest/executions?limit=50');
  const failed = (list.data?.data?.results ?? []).find((e) => e.status === 'error' || e.status === 'failed');
  const target = failed ?? (list.data?.data?.results ?? [])[0];
  if (target) {
    const rt = await req('POST', `/rest/executions/${target.id}/retry`, {});
    log(`[13 retry] 原=${target.id}(${target.status}) -> ${rt.status} 新id=${rt.data?.data?.executionId} retryOf=${rt.data?.data?.retryOf}`);
  }
}

// 7) 执行详情契约（前端读 resultData.runData）
{
  const list = await req('GET', '/rest/executions?limit=5');
  const e = (list.data?.data?.results ?? [])[0];
  if (e) {
    const d = await req('GET', `/rest/executions/${e.id}`);
    const dd = d.data?.data ?? {};
    const runData = dd?.data?.resultData?.runData;
    log(`[14 执行详情] status=${d.status} 有resultData=${!!dd?.data?.resultData} runData节点数=${runData ? Object.keys(runData).length : 'n/a'} lastNodeExecuted=${dd?.data?.resultData?.lastNodeExecuted}`);
  }
}

// 8) 残留鉴权面
{
  const r = await req('GET', '/rest/workflows', undefined, { noAuth: true });
  const r2 = await req('GET', '/rest/credentials', undefined, { noAuth: true });
  const r3 = await req('POST', '/rest/workflows', { name: 'anon', nodes: [], connections: {}, settings: {} }, { noAuth: true });
  log(`[15 匿名] GET /workflows=${r.status} GET /credentials=${r2.status} POST /workflows=${r3.status} （期望 401/401/401）`);
}

console.log('\n' + '='.repeat(60) + '\nE2E 结束');
