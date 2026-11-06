/**
 * Audit routes for dsh-harnessmm.
 *
 * The primary visual surface is the in-app conversation-view tab (client.js,
 * registered through the web client's `conversation.view` list slot); these Host
 * routes are its same-origin data source plus a self-contained HTML fallback page:
 *
 *   GET    /api/dsh-harnessmm            → savings dashboard (HTML fallback)
 *   GET    /api/dsh-harnessmm/status     → policy/config + per-session counters
 *   GET    /api/dsh-harnessmm/ledger     → events + per-substitution savings rows (?sessionId=…)
 *   DELETE /api/dsh-harnessmm/ledger     → clear one session (?sessionId=…) or all
 *
 * @module dsh-harnessmm/routes
 */

import { substitutions } from './ledger.js'

/** API base path. */
export const API_BASE = '/api/dsh-harnessmm'

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}

function sendHtml(res, html) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(html)
}

/** Read one query parameter out of a request URL. */
function queryParam(req, name) {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    return url.searchParams.get(name) ?? undefined
  } catch {
    return undefined
  }
}

/**
 * Build the route table.
 *
 * @param {object} input
 * @param {import('./ledger.js').Ledger} input.ledger
 * @param {object} input.policy resolved frozen policy
 * @param {object} input.config resolved plugin config
 * @param {string} input.toolName
 * @param {() => string} input.getShellTool lazily resolved native shell tool
 * @param {{enabled:boolean,path:string,error:string|null,bytes:number}} [input.persistence]
 */
export function createRoutes({ ledger, policy, config, toolName, getShellTool, persistence }) {
  const status = () => ({
    ok: true,
    plugin: 'dsh-harnessmm',
    policy,
    toolName,
    shellTool: getShellTool(),
    selector: { enabled: config.selector.enabled, maxTokens: config.selector.maxTokens },
    priors: config.priors ? { categories: Object.keys(config.priors.categories) } : null,
    persistence: persistence ?? { enabled: false, path: '', error: null, bytes: 0 },
    ...ledger.overview(),
  })

  return [
    {
      kind: 'exact',
      path: API_BASE,
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        sendHtml(res, dashboardHtml())
      },
    },
    {
      kind: 'exact',
      path: `${API_BASE}/status`,
      handler: async (req, res) => {
        if (req.method !== 'GET') {
          sendJson(res, 405, { ok: false, error: 'method not allowed' })
          return
        }
        sendJson(res, 200, status())
      },
    },
    {
      kind: 'exact',
      path: `${API_BASE}/ledger`,
      handler: async (req, res) => {
        if (req.method === 'GET') {
          const sessionId = queryParam(req, 'sessionId') ?? ledger.sessionIds()[0] ?? 'unknown'
          const events = ledger.events(sessionId)
          sendJson(res, 200, {
            ok: true,
            sessionId,
            summary: ledger.summary(sessionId),
            substitutions: substitutions(events),
            events,
            sessions: ledger.sessionIds(),
          })
          return
        }
        if (req.method === 'DELETE') {
          const sessionId = queryParam(req, 'sessionId')
          if (sessionId) ledger.clear(sessionId)
          else ledger.clearAll()
          sendJson(res, 200, { ok: true, cleared: sessionId ?? 'all' })
          return
        }
        sendJson(res, 405, { ok: false, error: 'method not allowed' })
      },
    },
  ]
}

/** Self-contained savings dashboard; no client bundle, no external assets. */
function dashboardHtml() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HarnessMM — 节省仪表盘</title>
<style>
  :root { color-scheme: light dark; --bg:#f6f7f9; --card:#fff; --text:#15181d; --muted:#5d6470; --line:#e3e6eb; --accent:#2f6bff; --ok:#0f9d6b; --warn:#b4690e; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f1216; --card:#171b21; --text:#e8ecf1; --muted:#9aa4b2; --line:#262c35; --accent:#6f9bff; --ok:#39c897; --warn:#e0a54a; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px 20px 64px; background:var(--bg); color:var(--text); font: 14px/1.55 ui-sans-serif, system-ui, "Segoe UI", "Microsoft YaHei", sans-serif; }
  .wrap { max-width: 1160px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; letter-spacing: -.01em; }
  h1 .en { font-size:13px; font-weight:400; color:var(--muted); margin-left:10px; }
  h2 { font-size: 15px; margin: 26px 0 10px; letter-spacing: -.01em; }
  h2 .en { font-size:12px; font-weight:400; color:var(--muted); margin-left:8px; }
  .sub { color: var(--muted); margin: 0 0 20px; }
  .grid { display:grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap:12px; margin-bottom: 12px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:14px 16px; }
  .card.save { border-color:color-mix(in srgb, var(--ok) 40%, var(--line)); }
  .card .k { color:var(--muted); font-size:12px; letter-spacing:.04em; }
  .card .k .en { text-transform:uppercase; letter-spacing:.06em; font-size:10.5px; opacity:.8; }
  .card .v { font-size:26px; font-weight:650; margin-top:4px; font-variant-numeric: tabular-nums; }
  .card .h { color:var(--muted); font-size:11.5px; margin-top:2px; }
  .fine { color:var(--muted); font-size:12px; margin:6px 2px 0; }
  .row { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin:18px 0 14px; }
  select, button { font: inherit; color: var(--text); background: var(--card); border:1px solid var(--line); border-radius:8px; padding:6px 10px; }
  button { cursor:pointer; }
  button:hover { border-color: var(--accent); }
  label.check { display:inline-flex; gap:6px; align-items:center; color:var(--muted); font-size:13px; }
  table { width:100%; border-collapse: collapse; background:var(--card); border:1px solid var(--line); border-radius:12px; overflow:hidden; }
  th, td { text-align:left; padding:9px 12px; border-bottom:1px solid var(--line); font-size:13px; vertical-align:top; }
  th { color:var(--muted); font-weight:600; font-size:12px; letter-spacing:.04em; }
  tr:last-child td { border-bottom:0; }
  td.num, th.num { text-align:right; font-variant-numeric: tabular-nums; white-space:nowrap; }
  code { font-family: ui-monospace, "Cascadia Code", Consolas, monospace; font-size:12px; }
  td code.cmd { word-break: break-all; }
  .tag { display:inline-block; padding:1px 7px; border-radius:999px; border:1px solid var(--line); font-size:11px; color:var(--muted); white-space:nowrap; }
  .tag.ok { color:var(--ok); border-color:color-mix(in srgb, var(--ok) 45%, var(--line)); }
  .tag.warn { color:var(--warn); border-color:color-mix(in srgb, var(--warn) 45%, var(--line)); }
  .empty { color:var(--muted); padding:22px; text-align:center; }
  .muted { color: var(--muted); }
  .snippet { color:var(--muted); font-size:12px; max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  details { margin-top:22px; }
  details summary { cursor:pointer; color:var(--muted); font-size:13px; margin-bottom:10px; }
  .scroll { max-height: 420px; overflow:auto; }
</style>
</head>
<body>
<div class="wrap">
  <h1>HarnessMM · 节省仪表盘<span class="en">savings dashboard</span></h1>
  <p class="sub">慢思考轮次编写动作库后，guard 成立的后继命令经原生 shell 直接执行——下面是每一次因此<b>没有发生</b>的模型调用。</p>

  <div class="grid" id="saveCards"></div>
  <div class="grid" id="ctxCards"></div>
  <p class="fine" id="basis"></p>

  <div class="row">
    <span class="muted">会话 Session</span>
    <select id="session"></select>
    <label class="check"><input type="checkbox" id="auto" checked> 自动刷新</label>
    <button id="refresh">刷新</button>
    <button id="clear">清空本会话</button>
    <span class="muted" id="note"></span>
  </div>

  <h2>省掉的推理调用<span class="en">bypassed slow calls</span></h2>
  <div class="scroll">
  <table>
    <thead><tr><th>时间</th><th>候选</th><th>命令（无模型调用执行）</th><th>guard</th><th>回执</th><th class="num">节省 tok</th><th>被省掉的回调</th></tr></thead>
    <tbody id="subs"><tr><td colspan="7" class="empty">加载中…</td></tr></tbody>
  </table>
  </div>

  <details>
    <summary>原始事件流（审计用） · raw event stream</summary>
    <div class="scroll">
    <table>
      <thead><tr><th style="width:210px">Event</th><th>Detail</th></tr></thead>
      <tbody id="events"><tr><td colspan="2" class="empty">加载中…</td></tr></tbody>
    </table>
    </div>
  </details>
</div>
<script>
const API = ${JSON.stringify(API_BASE)};
const saveCards = document.getElementById('saveCards');
const ctxCards = document.getElementById('ctxCards');
const select = document.getElementById('session');
const subsBody = document.getElementById('subs');
const eventsBody = document.getElementById('events');
const note = document.getElementById('note');
const basis = document.getElementById('basis');
const autoBox = document.getElementById('auto');
let loading = false;

function card(label, en, value, hint, save) {
  const el = document.createElement('div');
  el.className = 'card' + (save ? ' save' : '');
  const k = document.createElement('div'); k.className = 'k';
  k.append(label);
  if (en) { const e = document.createElement('span'); e.className = 'en'; e.textContent = ' ' + en; k.append(e); }
  const v = document.createElement('div'); v.className = 'v'; v.textContent = value;
  el.append(k, v);
  if (hint) { const h = document.createElement('div'); h.className = 'h'; h.textContent = hint; el.append(h); }
  return el;
}
function fmt(n) { return Number(n ?? 0).toLocaleString('en-US'); }
function renderSavings(summary) {
  const net = summary.estimated_saved_tokens - summary.selector_tokens_lost;
  saveCards.replaceChildren(
    card('省掉的推理调用', 'bypassed calls', fmt(summary.certified_substitutions), '每张证书 = 一次没发生的模型调用', true),
    card('估算节省 token', 'est. saved (proxy)', fmt(summary.estimated_saved_tokens), '编写轮次慢调用 token − 归因的选择器开销', true),
    card('选择器开销', 'selector spend', fmt(summary.selector_tokens), '其中未换来替换的: ' + fmt(summary.selector_tokens_lost) + ' tok'),
    card('净节省 token', 'net saved (proxy)', fmt(net), '估算节省 − 未换来替换的选择器开销', true),
  );
  ctxCards.replaceChildren(
    card('机制运行', 'runs', fmt(summary.runs)),
    card('动作库', 'banks authored', fmt(summary.banks_authored)),
    card('转回模型', 'deferred', fmt(summary.deferred)),
    card('选择器弃权', 'abstentions', fmt(summary.selector_abstentions)),
    card('无效动作库', 'invalid banks', fmt(summary.invalid_banks)),
    card('慢调用 token', 'slow tokens seen', fmt(summary.slow_tokens)),
  );
  basis.textContent = '估算口径：每次替换的节省 = 编写轮次的 usage.totalTokens（该代理下界见 admission.js 的 identity 声明）− 归因到该替换的选择器用量；会话日志不可用时按 0 计，绝不虚构。证书只证明那次推理调用没有发生，不声称精确的反事实 token。';
}
function guardText(guard) {
  if (!guard || typeof guard !== 'object') return '';
  return Object.keys(guard).map(function (key) {
    const v = guard[key];
    const text = (v === null || v === undefined) ? 'null' : (typeof v === 'object' ? JSON.stringify(v) : String(v));
    return key + '=' + text;
  }).join('\\u00b7 ');
}
function tag(text, ok) {
  const span = document.createElement('span');
  span.className = 'tag' + (ok ? ' ok' : ok === false ? ' warn' : '');
  span.textContent = text;
  return span;
}
function renderSubstitutions(rows) {
  if (!rows.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 7; td.className = 'empty';
    td.textContent = '本会话还没有被省掉的调用——让模型用 terminal 工具按 <CHISEL_PLAN> 契约编排一条确定性的命令链。';
    tr.append(td); subsBody.replaceChildren(tr);
    return;
  }
  subsBody.replaceChildren(...rows.slice().reverse().map(function (row) {
    const tr = document.createElement('tr');
    const at = document.createElement('td'); at.textContent = new Date(row.at).toLocaleTimeString(); tr.append(at);
    const cand = document.createElement('td'); cand.append(tag(row.candidate_id)); tr.append(cand);
    const cmd = document.createElement('td');
    const code = document.createElement('code'); code.className = 'cmd'; code.textContent = row.command ?? '';
    cmd.append(code); tr.append(cmd);
    const guard = document.createElement('td');
    const gcode = document.createElement('code'); gcode.textContent = guardText(row.guard);
    guard.append(gcode); tr.append(guard);
    const receipt = document.createElement('td');
    const rc = (row.return_code === null || row.return_code === undefined) ? tag('?', null) : tag(String(row.return_code), row.return_code === 0);
    const snip = document.createElement('div'); snip.className = 'snippet';
    snip.textContent = String(row.stdout ?? '').replace(/\\s+/g, ' ').slice(0, 120);
    snip.title = String(row.stdout ?? '');
    receipt.append(rc, snip); tr.append(receipt);
    const saved = document.createElement('td'); saved.className = 'num';
    saved.textContent = fmt(row.saved_tokens);
    saved.title = 'slow ' + fmt(row.slow_tokens) + ' − selector ' + fmt(row.selector_tokens);
    tr.append(saved);
    const bypassed = document.createElement('td');
    const bcode = document.createElement('code');
    bcode.textContent = String(row.bypassed_slow_callback_id ?? '');
    if (bcode.textContent.length > 34) bcode.textContent = bcode.textContent.slice(0, 31) + '…';
    bcode.title = String(row.bypassed_slow_callback_id ?? '');
    bypassed.append(bcode); tr.append(bypassed);
    return tr;
  }));
}
function describe(event) {
  const parts = [];
  if (event.bank_sha256) parts.push('bank ' + String(event.bank_sha256).slice(0, 12));
  if (event.candidate_id) parts.push('candidate ' + event.candidate_id);
  if (event.reason) parts.push('reason ' + event.reason);
  if (event.outcome) parts.push('outcome ' + event.outcome);
  if (event.stop_reason) parts.push('stop ' + event.stop_reason);
  if (event.substitutions !== undefined) parts.push(event.substitutions + ' substitutions');
  if (event.error) parts.push('error ' + event.error);
  if (event.candidates !== undefined) parts.push(event.candidates + ' candidates');
  if (event.slow_tokens !== undefined) parts.push('slow ' + event.slow_tokens + ' tok');
  if (event.estimated_net_saving !== undefined) parts.push('net ~' + event.estimated_net_saving);
  const rest = Object.assign({}, event);
  delete rest.at; delete rest.kind;
  return parts.join(' · ') || JSON.stringify(rest).slice(0, 220);
}
function renderEvents(events) {
  if (!events.length) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 2; td.className = 'empty';
    td.textContent = '本会话还没有 HarnessMM 事件。';
    tr.append(td); eventsBody.replaceChildren(tr);
    return;
  }
  eventsBody.replaceChildren(...events.slice().reverse().map(function (event) {
    const tr = document.createElement('tr');
    const kindCell = document.createElement('td');
    const kcode = document.createElement('code'); kcode.textContent = event.kind;
    kindCell.append(kcode, document.createElement('br'), tag(new Date(event.at).toLocaleTimeString(), event.kind.indexOf('certificate') >= 0));
    const detailCell = document.createElement('td');
    detailCell.textContent = describe(event);
    tr.append(kindCell, detailCell);
    return tr;
  }));
}
async function loadStatus() {
  const response = await fetch(API + '/status');
  const status = await response.json();
  const previous = select.value;
  select.replaceChildren(...status.sessions.map(function (session) {
    const option = document.createElement('option');
    option.value = session.sessionId;
    const parts = String(session.project || '').split(/[\\\\/]+/).filter(Boolean);
    const project = parts.length > 0 ? parts[parts.length - 1] : '未分组';
    option.textContent = project + ' · ' + session.sessionId + ' (' + session.certified_substitutions + ' 次 · ~' + fmt(session.estimated_saved_tokens) + ' tok)';
    return option;
  }));
  if (previous && select.querySelector('option[value="' + CSS.escape(previous) + '"]')) select.value = previous;
  const current = status.sessions.find(function (s) { return s.sessionId === select.value; }) || status.totals;
  renderSavings(current);
  const persisted = status.persistence && status.persistence.enabled ? '已落盘' : '仅内存';
  note.textContent = 'policy v' + status.policy.version + ' · tool ' + status.toolName + ' → ' + status.shellTool + ' · 账本' + persisted;
}
async function loadLedger() {
  const sessionId = select.value;
  const response = await fetch(API + '/ledger' + (sessionId ? '?sessionId=' + encodeURIComponent(sessionId) : ''));
  const data = await response.json();
  renderSubstitutions(data.substitutions ?? []);
  renderEvents(data.events ?? []);
  if (data.summary) renderSavings(data.summary);
}
async function reload() {
  if (loading) return;
  loading = true;
  try { await loadStatus(); await loadLedger(); } finally { loading = false; }
}
select.addEventListener('change', loadLedger);
document.getElementById('refresh').addEventListener('click', reload);
document.getElementById('clear').addEventListener('click', async function () {
  if (!select.value || !confirm('清空本会话的 HarnessMM 账本?')) return;
  await fetch(API + '/ledger?sessionId=' + encodeURIComponent(select.value), { method: 'DELETE' });
  await reload();
});
setInterval(function () { if (autoBox.checked) reload(); }, 5000);
reload();
</script>
</body>
</html>`
}
