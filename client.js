/**
 * dsh-harnessmm — Client half of the bundle.
 *
 * The export PATH in package.json (`./client`) is the browser module identity;
 * bump it to a new file (client.v2.js, …) to hand an open page a fresh module
 * generation without an app restart.
 *
 * One surface: a conversation-view tab named "节省" / "Savings" in the session
 * tab strip, immediately to the right of "编队" (dsh-context's Fleet tab uses
 * order 30). The tab body is the savings dashboard: the four savings cards, the
 * context counters, one row per bypassed slow call (command, guard, exact
 * receipt, proxy saving, the callback that did not happen) and the raw audit
 * stream. It is session-scoped, so the ledger it reads is the open session's.
 *
 * All data arrives over HTTP; the browser never touches the ledger directly.
 * Styling inherits the host theme through --dsw-alias-* tokens.
 */
window.__ModuleLoader__.load({
  // Must equal package.json's "name": the loader keys factories by package and
  // treats a missing row as "not registered", retrying this bundle until it
  // duplicates. Other plugin bundles use their full package name here.
  id: 'dsh-harnessmm-plugin',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'dsh-harnessmm';
    const STYLE_ID = 'dsh-harnessmm-style';
    const ROUTE = '/api/dsh-harnessmm';
    const REFRESH_MS = 10000;
    // dsh-context: context tab = 20, Fleet tab = 30; sit right after Fleet.
    const TAB_ORDER = 40;
    const TAB_ID = 'harnessmm';

    // Inline dictionaries; locale/*.json files carry Plugin Manager meta.
    const DICT = {
      zh: {
        'tab.savings': '节省',
        'state.loading': '正在读取 HarnessMM 账本…',
        'state.error': 'HarnessMM 账本不可用',
        'action.refresh': '刷新',
        'action.clear': '清空本会话',
        'action.html': 'HTML 面板',
        'action.events': '原始事件流（审计用）',
        'page.title': 'HarnessMM 节省',
        'page.badge': '策略 v{{version}} · {{tool}} → {{shell}}',
        'total.label': '全部会话',
        'total.value': '{{calls}} 次 · ~{{saved}} tok',
        'card.calls': '省掉的推理调用',
        'card.callsSub': '每张证书 = 一次没发生的模型调用',
        'card.saved': '估算节省 token',
        'card.savedSub': '编写轮次慢调用 token − 归因的选择器开销',
        'card.selector': '选择器开销',
        'card.selectorSub': '其中未换来替换的：{{lost}} tok',
        'card.net': '净节省 token',
        'card.netSub': '估算节省 − 未换来替换的选择器开销',
        'ctx.runs': '机制运行',
        'ctx.banks': '动作库',
        'ctx.deferred': '转回模型',
        'ctx.abstentions': '选择器弃权',
        'ctx.invalid': '无效动作库',
        'ctx.slow': '慢调用 token',
        'basis': '估算口径：每次替换的节省 = 编写轮次的 usage.totalTokens − 归因到该替换的选择器用量；会话日志不可用时按 0 计，绝不虚构。证书只证明那次推理调用没有发生，不声称精确的反事实 token。',
        'subs.title': '省掉的推理调用',
        'col.time': '时间',
        'col.candidate': '候选',
        'col.command': '命令（无模型调用执行）',
        'col.guard': 'guard',
        'col.receipt': '回执',
        'col.saved': '节省 tok',
        'col.bypassed': '被省掉的回调',
        'subs.empty': '本会话还没有被省掉的调用——让模型用 terminal 工具按 <CHISEL_PLAN> 契约编排一条确定性的命令链。',
        'events.empty': '本会话还没有 HarnessMM 事件。',
        'clear.confirm': '清空该会话的 HarnessMM 账本？',
        'session.label': '会话',
        'session.pick': '选择会话',
        'session.noProject': '未分组',
        'persist.on': '历史已保存',
        'persist.off': '仅内存',
        'persist.error': '持久化失败',
      },
      en: {
        'tab.savings': 'Savings',
        'state.loading': 'Loading the HarnessMM ledger…',
        'state.error': 'HarnessMM ledger unavailable',
        'action.refresh': 'Refresh',
        'action.clear': 'Clear this session',
        'action.html': 'HTML panel',
        'action.events': 'Raw event stream (audit)',
        'page.title': 'HarnessMM savings',
        'page.badge': 'policy v{{version}} · {{tool}} → {{shell}}',
        'total.label': 'All sessions',
        'total.value': '{{calls}} calls · ~{{saved}} tok',
        'card.calls': 'Bypassed slow calls',
        'card.callsSub': 'each certificate = one model call that did not happen',
        'card.saved': 'Est. saved tokens (proxy)',
        'card.savedSub': 'authoring-turn slow tokens − attributed selector spend',
        'card.selector': 'Selector spend',
        'card.selectorSub': 'of which unrecovered: {{lost}} tok',
        'card.net': 'Net saved tokens (proxy)',
        'card.netSub': 'estimated saved − unrecovered selector spend',
        'ctx.runs': 'Runs',
        'ctx.banks': 'Banks authored',
        'ctx.deferred': 'Deferred to model',
        'ctx.abstentions': 'Selector abstentions',
        'ctx.invalid': 'Invalid banks',
        'ctx.slow': 'Slow tokens seen',
        'basis': 'Basis: each substitution saves the authoring turn’s usage.totalTokens minus the selector spend attributed to it; without a session log the estimate is 0 — never invented. A certificate only proves the slow call did not happen; it makes no counterfactual token claim.',
        'subs.title': 'Bypassed slow calls',
        'col.time': 'Time',
        'col.candidate': 'Cand.',
        'col.command': 'Command (ran without a model call)',
        'col.guard': 'guard',
        'col.receipt': 'Receipt',
        'col.saved': 'Saved tok',
        'col.bypassed': 'Bypassed callback',
        'subs.empty': 'No bypassed calls in this session yet — ask the model to chain deterministic commands through the terminal tool under the <CHISEL_PLAN> contract.',
        'events.empty': 'No HarnessMM events in this session yet.',
        'clear.confirm': 'Clear the HarnessMM ledger for this session?',
        'session.label': 'Session',
        'session.pick': 'Choose session',
        'session.noProject': 'Ungrouped',
        'persist.on': 'History saved',
        'persist.off': 'Memory only',
        'persist.error': 'Persistence failed',
      },
    };

    function lookup(dict, path) {
      if (dict && Object.hasOwn(dict, path)) return dict[path];
      return path.split('.').reduce((node, key) => (node && typeof node === 'object' ? node[key] : undefined), dict);
    }

    function interpolate(template, vars) {
      if (typeof template !== 'string') return template;
      return template.replace(/\{\{(\w+)\}\}/g, (match, name) => (vars && vars[name] !== undefined ? String(vars[name]) : match));
    }

    function createT(ctx) {
      try {
        if (ctx.locale && typeof ctx.locale.register === 'function') {
          ctx.locale.register(NS, { zh: DICT.zh, en: DICT.en });
          const bound = ctx.locale.bind(NS);
          if (typeof bound === 'function') {
            return (key, vars) => {
              const value = bound(key);
              return typeof value === 'string' ? interpolate(value, vars) : interpolate(lookup(DICT.zh, key) ?? key, vars);
            };
          }
        }
      } catch {
        // Locale service unavailable: fall back to the inline dictionaries.
      }
      const language = String((ctx.locale && ctx.locale.language) || (typeof navigator !== 'undefined' ? navigator.language : 'zh') || 'zh');
      const dict = language.toLowerCase().startsWith('zh') ? DICT.zh : DICT.en;
      return (key, vars) => interpolate(lookup(dict, key) ?? key, vars);
    }

    function languageOf(ctx) {
      const language = String((ctx.locale && ctx.locale.language) || (typeof navigator !== 'undefined' ? navigator.language : 'zh') || 'zh');
      return language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
    }

    /** Compact count: zh uses 万/亿, en uses K/M/B. */
    function formatCount(value, lang) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
      if (lang === 'zh') {
        if (value >= 1e8) return `${(value / 1e8).toFixed(value >= 1e9 ? 0 : 1)}亿`;
        if (value >= 1e4) return `${(value / 1e4).toFixed(value >= 1e6 ? 0 : 1)}万`;
        return value.toLocaleString('en-US');
      }
      if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
      if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
      if (value >= 1e3) return `${(value / 1e3).toFixed(1)}K`;
      return value.toLocaleString('en-US');
    }

    /** Render one guard object as `return_code=0 · stdout_contains=PASS`. */
    function guardText(guard) {
      if (!guard || typeof guard !== 'object') return '';
      return Object.keys(guard).map((key) => {
        const value = guard[key];
        const text = value === null || value === undefined ? 'null' : typeof value === 'object' ? JSON.stringify(value) : String(value);
        return `${key}=${text}`;
      }).join(' · ');
    }

    /** One ledger event -> a short audit line. */
    function describe(event) {
      const parts = [];
      if (event.bank_sha256) parts.push(`bank ${String(event.bank_sha256).slice(0, 12)}`);
      if (event.candidate_id) parts.push(`candidate ${event.candidate_id}`);
      if (event.reason) parts.push(`reason ${event.reason}`);
      if (event.outcome) parts.push(`outcome ${event.outcome}`);
      if (event.stop_reason) parts.push(`stop ${event.stop_reason}`);
      if (event.substitutions !== undefined) parts.push(`${event.substitutions} substitutions`);
      if (event.error) parts.push(`error ${event.error}`);
      if (event.candidates !== undefined) parts.push(`${event.candidates} candidates`);
      if (event.slow_tokens !== undefined) parts.push(`slow ${event.slow_tokens} tok`);
      const rest = { ...event };
      delete rest.at;
      delete rest.kind;
      return parts.join(' · ') || JSON.stringify(rest).slice(0, 220);
    }

    /** Fetch one Host JSON route; throws on non-2xx. */
    function fetchJson(path) {
      return fetch(path, { credentials: 'same-origin', headers: { accept: 'application/json' } }).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      });
    }

    /** Shared poll-into-state hook: immediate + interval refresh. */
    function usePolled(loader, refreshMs) {
      const [state, setState] = React.useState({ loading: true, data: null, error: null });
      const load = React.useCallback(() => {
        let cancelled = false;
        setState((previous) => ({ ...previous, loading: true }));
        Promise.resolve()
          .then(loader)
          .then((data) => {
            if (!cancelled) setState({ loading: false, data, error: null });
          })
          .catch((error) => {
            if (!cancelled) setState({ loading: false, data: null, error: String(error && error.message ? error.message : error) });
          });
        return () => {
          cancelled = true;
        };
      }, [loader]);
      React.useEffect(() => {
        const cleanup = load();
        const timer = setInterval(load, refreshMs);
        return () => {
          cleanup();
          clearInterval(timer);
        };
      }, [load, refreshMs]);
      return [state, load];
    }

    /**
     * Install (or refresh) the plugin stylesheet.
     *
     * Host HMR tears a plugin fiber down and re-imports the bundle in place,
     * so an existing tag must be updated rather than skipped. `data-plugin`
     * marks ownership so the Host's removeOwnedStyles drops the tag together
     * with the old fiber.
     */
    function ensureStyle() {
      if (typeof document === 'undefined') return;
      let style = document.getElementById(STYLE_ID);
      if (style === null) {
        style = document.createElement('style');
        style.id = STYLE_ID;
        document.head.appendChild(style);
      }
      style.setAttribute('data-plugin', NS);
      if (style.textContent !== styleText) style.textContent = styleText;
    }

    const styleText = `
.dhm-root{min-width:0}
.dhm-stat-label{color:var(--dsw-alias-label-tertiary,#999);font-size:12px}
.dhm-badge{padding:1px 6px;border-radius:var(--dsw-radius-sm,4px);background:var(--dsw-alias-accent-primary-soft,rgba(47,124,246,.12));color:var(--dsw-alias-accent-primary,#2f7cf6);font-size:11px;font-variant-numeric:tabular-nums;white-space:nowrap}
.dhm-error{color:var(--dsw-alias-state-error-primary,#e5484d);font-size:11px}
.dhm-btn{padding:2px 8px;border-radius:var(--dsw-radius-md,6px);border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));background:transparent;color:var(--dsw-alias-label-secondary,#666);font-size:11px;cursor:pointer;white-space:nowrap;text-decoration:none;line-height:1.6}
.dhm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(0,0,0,.05));color:var(--dsw-alias-label-primary,#333)}
.dhm-btn:disabled{opacity:.55;cursor:default}
.dhm-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#2f7cf6);outline-offset:1px}
.dhm-select{font:inherit;font-size:11.5px;color:var(--dsw-alias-label-secondary,#666);background:transparent;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:var(--dsw-radius-md,6px);padding:2px 6px;max-width:300px}
.dhm-select:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,#2f7cf6);outline-offset:1px}
.dhm-persist{font-size:11px;color:var(--dsw-alias-label-tertiary,#999);white-space:nowrap}
.dhm-persist.error{color:var(--dsw-alias-state-error-primary,#e5484d)}
.dhm-spacer{flex:1 1 auto}
.dhm-page{padding:20px 24px 32px;color:var(--dsw-alias-label-primary,#333);font-size:13px;overflow-y:auto;height:100%;box-sizing:border-box;background:var(--dsw-alias-bg-base)}
.dhm-page-inner{max-width:1160px;margin:0 auto;display:flex;flex-direction:column;gap:16px}
.dhm-page-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.dhm-page-title{font-size:22px;font-weight:700;margin:0;color:var(--dsw-alias-label-primary,#333)}
.dhm-page-badge{padding:2px 10px;border-radius:999px;background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.06));color:var(--dsw-alias-label-secondary,#666);font-size:12px;font-variant-numeric:tabular-nums}
.dhm-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.dhm-card{padding:14px 16px;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.04));border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.06));display:flex;flex-direction:column;gap:5px;min-width:0}
.dhm-card.save{border-color:var(--dsw-alias-state-success-soft,rgba(15,157,107,.35))}
.dhm-card-value{font-size:22px;font-weight:700;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-primary,#333);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dhm-card-label{font-size:12px;color:var(--dsw-alias-label-tertiary,#999)}
.dhm-card-sub{font-size:11px;color:var(--dsw-alias-label-tertiary,#aaa)}
.dhm-section{padding:16px;border-radius:var(--dsw-radius-lg,12px);background:var(--dsw-alias-bg-layer-1,rgba(0,0,0,.04));border:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.06));display:flex;flex-direction:column;gap:10px}
.dhm-section-title{font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary,#333)}
.dhm-basis{color:var(--dsw-alias-label-tertiary,#999);font-size:11.5px;line-height:1.55;margin:0}
.dhm-tablewrap{overflow-x:auto}
.dhm-table{width:100%;border-collapse:collapse;font-size:12.5px}
.dhm-table th{color:var(--dsw-alias-label-tertiary,#999);font-weight:600;font-size:11px;text-align:left;padding:6px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.08));white-space:nowrap}
.dhm-table td{padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(0,0,0,.05));vertical-align:top}
.dhm-table tr:last-child td{border-bottom:none}
.dhm-num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.dhm-code{font-family:var(--dsw-font-mono,ui-monospace,'Cascadia Code',Consolas,monospace);font-size:11.5px;color:var(--dsw-alias-label-secondary,#555)}
.dhm-cmd{word-break:break-all;color:var(--dsw-alias-label-primary,#333)}
.dhm-tag{display:inline-block;padding:1px 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l3,rgba(0,0,0,.12));font-size:11px;color:var(--dsw-alias-label-secondary,#666);white-space:nowrap}
.dhm-tag.ok{color:var(--dsw-alias-state-success-primary,#0f9d6b);border-color:var(--dsw-alias-state-success-soft,rgba(15,157,107,.45))}
.dhm-tag.warn{color:var(--dsw-alias-state-warning-primary,#b4690e);border-color:var(--dsw-alias-state-warning-soft,rgba(180,105,14,.45))}
.dhm-snippet{color:var(--dsw-alias-label-tertiary,#999);font-size:11.5px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px}
.dhm-empty{padding:26px 12px;text-align:center;color:var(--dsw-alias-label-tertiary,#999);border:1px dashed var(--dsw-alias-border-l3,rgba(0,0,0,.12));border-radius:var(--dsw-radius-md,8px)}
.dhm-events{display:flex;flex-direction:column;gap:6px;max-height:360px;overflow-y:auto}
.dhm-event{display:grid;grid-template-columns:210px 1fr;gap:10px;align-items:start}
.dhm-event-kind{display:flex;flex-direction:column;gap:2px;align-items:flex-start}
.dhm-event-time{color:var(--dsw-alias-label-tertiary,#999);font-size:10.5px;font-variant-numeric:tabular-nums}
.dhm-event-detail{color:var(--dsw-alias-label-secondary,#666);font-size:12px;word-break:break-word}
`;

    /** Card used by the dashboard grids. */
    function Card({ label, value, sub, save }) {
      return h('div', { className: 'dhm-card' + (save ? ' save' : '') },
        h('div', { className: 'dhm-card-value' }, value),
        h('div', { className: 'dhm-card-label' }, label),
        sub ? h('div', { className: 'dhm-card-sub' }, sub) : null);
    }

    function Tag({ text, tone }) {
      return h('span', { className: 'dhm-tag' + (tone === 'ok' ? ' ok' : tone === 'warn' ? ' warn' : '') }, text);
    }

    // ---- one bypassed slow call ---------------------------------------------
    function SubstitutionRow({ row }) {
      const rc = row.return_code === null || row.return_code === undefined
        ? h(Tag, { text: '?' })
        : h(Tag, { text: String(row.return_code), tone: row.return_code === 0 ? 'ok' : 'warn' });
      const bypassed = String(row.bypassed_slow_callback_id ?? '');
      return h('tr', null,
        h('td', null, new Date(row.at).toLocaleTimeString()),
        h('td', null, h(Tag, { text: String(row.candidate_id ?? '') })),
        h('td', null, h('code', { className: 'dhm-code dhm-cmd' }, row.command ?? '')),
        h('td', null, h('code', { className: 'dhm-code' }, guardText(row.guard))),
        h('td', null,
          rc,
          h('div', { className: 'dhm-snippet', title: String(row.stdout ?? '') }, String(row.stdout ?? '').replace(/\s+/g, ' ').slice(0, 120))),
        h('td', { className: 'dhm-num', title: `slow ${row.slow_tokens} − selector ${row.selector_tokens}` }, formatCount(row.saved_tokens, 'en')),
        h('td', null, h('code', { className: 'dhm-code', title: bypassed }, bypassed.length > 34 ? `${bypassed.slice(0, 31)}…` : bypassed)));
    }

    /** Last path segment of a project cwd, for compact labels. */
    function projectName(project, fallback) {
      if (typeof project !== 'string' || project.length === 0) return fallback;
      const parts = project.split(/[\\/]+/).filter(Boolean);
      return parts.length > 0 ? parts[parts.length - 1] : project;
    }

    /** Compact session id for a picker option; the full id stays in `title`. */
    function shortSession(id) {
      const text = String(id ?? '');
      return text.length > 14 ? `…${text.slice(-10)}` : text;
    }

    // ---- the savings tab body (registered into `conversation.view`) ----------
    function HarnessView({ t, lang, sessionId }) {
      const statusLoader = React.useCallback(() => fetchJson(`${ROUTE}/status`), []);
      const [statusState, reloadStatus] = usePolled(statusLoader, REFRESH_MS);
      const status = statusState.data;
      const sessions = (status && status.sessions) || [];
      const bound = String(sessionId || '');
      // Session-scoped view: default to the open session, but let the picker
      // browse every session the (persisted) ledger knows about.
      const [picked, setPicked] = React.useState('');
      const effective = picked || bound || (sessions[0] && sessions[0].sessionId) || '';

      const ledgerLoader = React.useCallback(
        () => fetchJson(`${ROUTE}/ledger${effective ? `?sessionId=${encodeURIComponent(effective)}` : ''}`),
        [effective],
      );
      const [ledgerState, reloadLedger] = usePolled(ledgerLoader, REFRESH_MS);
      const [eventsOpen, setEventsOpen] = React.useState(false);

      const reload = React.useCallback(() => {
        reloadStatus();
        reloadLedger();
      }, [reloadStatus, reloadLedger]);

      const clear = async () => {
        if (!effective) return;
        try {
          if (!window.confirm(t('clear.confirm'))) return;
        } catch {
          /* a host without confirm: proceed */
        }
        await fetch(`${ROUTE}/ledger?sessionId=${encodeURIComponent(effective)}`, { method: 'DELETE' });
        reload();
      };

      const summary = ledgerState.data && ledgerState.data.summary;
      const totals = status && status.totals;
      const rows = (ledgerState.data && ledgerState.data.substitutions) || [];
      const events = (ledgerState.data && ledgerState.data.events) || [];
      const net = summary ? summary.estimated_saved_tokens - summary.selector_tokens_lost : 0;
      const selected = sessions.find((row) => row.sessionId === effective) || null;
      const project = selected && typeof selected.project === 'string' ? selected.project : '';
      const persistence = status && status.persistence;

      // Session picker, grouped by project (session cwd). Groups are ordered by
      // their saved tokens; the active session's group stays first.
      const pickerRows = sessions.slice();
      if (effective && !pickerRows.some((row) => row.sessionId === effective)) {
        pickerRows.unshift({ sessionId: effective, project: '', certified_substitutions: 0, estimated_saved_tokens: 0 });
      }
      const groups = [];
      const groupIndex = new Map();
      for (const row of pickerRows) {
        const key = typeof row.project === 'string' ? row.project : '';
        let group = groupIndex.get(key);
        if (!group) {
          group = { project: key, rows: [], saved: 0 };
          groupIndex.set(key, group);
          groups.push(group);
        }
        group.rows.push(row);
        group.saved += Number(row.estimated_saved_tokens ?? 0);
      }
      groups.sort((a, b) => b.saved - a.saved);
      const activeGroup = groups.findIndex((group) => group.rows.some((row) => row.sessionId === effective));
      if (activeGroup > 0) groups.unshift(...groups.splice(activeGroup, 1));

      const picker = h('select', {
        className: 'dhm-select',
        value: effective,
        'aria-label': t('session.pick'),
        onChange: (event) => setPicked(event.target.value),
      }, groups.map((group) => h('optgroup', {
        key: group.project || '__none__',
        label: `${projectName(group.project, t('session.noProject'))} · ~${formatCount(group.saved, lang)} tok`,
      }, group.rows.map((row) => h('option', {
        key: row.sessionId,
        value: row.sessionId,
        title: row.sessionId,
      }, `${shortSession(row.sessionId)} · ${formatCount(row.certified_substitutions, lang)} · ~${formatCount(row.estimated_saved_tokens, lang)} tok`)))));

      const cards = summary
        ? h(React.Fragment, null,
            h('div', { className: 'dhm-cards' },
              h(Card, { save: true, label: t('card.calls'), value: formatCount(summary.certified_substitutions, lang), sub: t('card.callsSub') }),
              h(Card, { save: true, label: t('card.saved'), value: formatCount(summary.estimated_saved_tokens, lang), sub: t('card.savedSub') }),
              h(Card, { label: t('card.selector'), value: formatCount(summary.selector_tokens, lang), sub: interpolate(t('card.selectorSub'), { lost: formatCount(summary.selector_tokens_lost, lang) }) }),
              h(Card, { save: true, label: t('card.net'), value: formatCount(net, lang), sub: t('card.netSub') })),
            h('div', { className: 'dhm-cards' },
              h(Card, { label: t('ctx.runs'), value: formatCount(summary.runs, lang) }),
              h(Card, { label: t('ctx.banks'), value: formatCount(summary.banks_authored, lang) }),
              h(Card, { label: t('ctx.deferred'), value: formatCount(summary.deferred, lang) }),
              h(Card, { label: t('ctx.abstentions'), value: formatCount(summary.selector_abstentions, lang) }),
              h(Card, { label: t('ctx.invalid'), value: formatCount(summary.invalid_banks, lang) }),
              h(Card, { label: t('ctx.slow'), value: formatCount(summary.slow_tokens, lang) })),
            h('p', { className: 'dhm-basis' }, t('basis')))
        : null;

      const subsBody = rows.length === 0
        ? h('div', { className: 'dhm-empty' }, t('subs.empty'))
        : h('div', { className: 'dhm-tablewrap' },
            h('table', { className: 'dhm-table' },
              h('thead', null,
                h('tr', null,
                  h('th', null, t('col.time')),
                  h('th', null, t('col.candidate')),
                  h('th', null, t('col.command')),
                  h('th', null, t('col.guard')),
                  h('th', null, t('col.receipt')),
                  h('th', { className: 'dhm-num' }, t('col.saved')),
                  h('th', null, t('col.bypassed')))),
              h('tbody', null, rows.slice().reverse().map((row) => h(SubstitutionRow, { key: `${row.bank_sha256}:${row.candidate_id}:${row.at}`, row })))));

      const eventsBody = !eventsOpen
        ? null
        : events.length === 0
          ? h('div', { className: 'dhm-empty' }, t('events.empty'))
          : h('div', { className: 'dhm-events' },
              events.slice().reverse().map((event, index) =>
                h('div', { className: 'dhm-event', key: `${event.at}:${index}` },
                  h('div', { className: 'dhm-event-kind' },
                    h('code', { className: 'dhm-code' }, event.kind),
                    h(Tag, { text: new Date(event.at).toLocaleTimeString(), tone: event.kind.indexOf('certificate') >= 0 ? 'ok' : null })),
                  h('div', { className: 'dhm-event-detail' }, describe(event)))));

      return h('div', { className: 'dhm-page' },
        h('div', { className: 'dhm-page-inner' },
          h('div', { className: 'dhm-page-head' },
            h('h1', { className: 'dhm-page-title' }, t('page.title')),
            status
              ? h('span', { className: 'dhm-page-badge' }, interpolate(t('page.badge'), {
                  version: status.policy.version,
                  tool: status.toolName,
                  shell: status.shellTool || 'auto',
                }))
              : null,
            totals
              ? h('span', {
                  className: 'dhm-badge',
                  title: t('total.label'),
                }, `${t('total.label')} ${interpolate(t('total.value'), {
                  calls: formatCount(totals.certified_substitutions, lang),
                  saved: formatCount(totals.estimated_saved_tokens, lang),
                })}`)
              : null,
            h('span', { className: 'dhm-spacer' }),
            h('span', { className: 'dhm-page-badge', title: project || t('session.noProject') }, `${t('session.label')} ${projectName(project, t('session.noProject'))}`),
            persistence
              ? h('span', {
                  className: `dhm-persist${persistence.error ? ' error' : ''}`,
                  title: persistence.error || persistence.path || '',
                }, persistence.error ? t('persist.error') : persistence.enabled ? t('persist.on') : t('persist.off'))
              : null,
            picker,
            h('button', { type: 'button', className: 'dhm-btn', onClick: reload, disabled: statusState.loading }, t('action.refresh')),
            h('button', { type: 'button', className: 'dhm-btn', onClick: clear }, t('action.clear')),
            h('a', { className: 'dhm-btn', href: ROUTE, target: '_blank', rel: 'noreferrer' }, t('action.html'))),
          !summary && !ledgerState.error ? h('div', { className: 'dhm-stat-label' }, t('state.loading')) : null,
          ledgerState.error ? h('span', { className: 'dhm-error' }, t('state.error')) : null,
          cards,
          h('div', { className: 'dhm-section' },
            h('div', { className: 'dhm-section-title' }, t('subs.title')),
            subsBody),
          h('div', { className: 'dhm-section' },
            h('button', { type: 'button', className: 'dhm-btn', onClick: () => setEventsOpen((value) => !value), 'aria-expanded': eventsOpen }, eventsOpen ? '▾' : '▸', ' ', t('action.events')),
            eventsBody)));
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ensureStyle();
        const t = createT(ctx);
        const lang = languageOf(ctx);
        // A conversation-view tab in the session tab strip, next to 编队 /
        // Fleet (dsh-context registers context=20, fleet=30; builtin
        // chat/trajectory are lower). The list slot's `label` is the tab text.
        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: TAB_ID,
          order: TAB_ORDER,
          locale: NS,
          label: () => t('tab.savings'),
        }, (props) => h(HarnessView, { t, lang, sessionId: props && props.sessionId })));
      },
    };
  },
});
