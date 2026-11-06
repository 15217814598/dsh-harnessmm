/**
 * Per-session ledger of HarnessMM events.
 *
 * Event kinds and payloads mirror the HarnessMM controller so a ledger written by
 * this plugin is comparable with the reference implementation's:
 *
 *   sar/slow-call, sar/bank-authored, sar/pre-admission, sar/defer,
 *   sar/deterministic-commit, sar/substitution-certificate,
 *   sar/uncertified-execution, jev/request, jev/decision, jev/slow-fallback,
 *   jev/compiled-native-action, jev/full-cot, jev/invalid-bank, harnessmm/run
 *
 * Events are bucketed by session id; the optional store mirrors them to disk so
 * a restarted profile still has the history. Sessions also carry the project
 * (the session header's cwd) so the dashboard can group them.
 *
 * @module dsh-harnessmm/ledger
 */

const DEFAULT_LIMIT = 4000

/** One ledger for every session of the profile. */
export class Ledger {
  #sessions = new Map()
  #limit
  #store

  /**
   * @param {{limit?:number, store?:{load():Map<string,object[]>, append(id:string,event:object):void, remove(id:string):void, clear():void}}} [options]
   */
  constructor(options = {}) {
    this.#limit = Number.isSafeInteger(options.limit) && options.limit > 0 ? options.limit : DEFAULT_LIMIT
    this.#store = options.store ?? null
    this.#hydrate()
  }

  /** Restore persisted events before the first tool call of this process. */
  #hydrate() {
    if (!this.#store || typeof this.#store.load !== 'function') return
    let loaded
    try {
      loaded = this.#store.load()
    } catch {
      return
    }
    if (!(loaded instanceof Map)) return
    for (const [sessionId, events] of loaded) {
      if (!Array.isArray(events) || events.length === 0) continue
      const entry = { sessionId: String(sessionId), createdAt: 0, updatedAt: 0, project: '', events: [] }
      for (const event of events) {
        if (!event || typeof event !== 'object') continue
        const at = typeof event.at === 'number' ? event.at : Date.now()
        entry.events.push({ at, ...event })
        if (typeof event.project === 'string' && event.project.length > 0) entry.project = event.project
      }
      if (entry.events.length > this.#limit) entry.events.splice(0, entry.events.length - this.#limit)
      if (entry.events.length === 0) continue
      entry.createdAt = entry.events[0].at
      entry.updatedAt = entry.events[entry.events.length - 1].at
      this.#sessions.set(entry.sessionId, entry)
    }
  }

  /** Append one event for a session (the tool-call id or session id both work as a key). */
  record(sessionId, event) {
    const key = String(sessionId ?? 'unknown')
    let entry = this.#sessions.get(key)
    if (!entry) {
      entry = { sessionId: key, createdAt: Date.now(), updatedAt: 0, project: '', events: [] }
      this.#sessions.set(key, entry)
    }
    const stored = { at: Date.now(), ...event }
    entry.events.push(stored)
    if (typeof stored.project === 'string' && stored.project.length > 0) entry.project = stored.project
    if (entry.events.length > this.#limit) entry.events.splice(0, entry.events.length - this.#limit)
    entry.updatedAt = stored.at
    try {
      this.#store?.append(key, stored)
    } catch {
      /* the store already reports its own failures */
    }
    return entry.events.length
  }

  /** Every retained event of one session, in append order. */
  events(sessionId) {
    return this.#sessions.get(String(sessionId ?? 'unknown'))?.events ?? []
  }

  /** The project (session cwd) a session's records were tagged with. */
  project(sessionId) {
    return this.#sessions.get(String(sessionId ?? 'unknown'))?.project ?? ''
  }

  /** Session ids with at least one event, most recently updated first. */
  sessionIds() {
    return [...this.#sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((entry) => entry.sessionId)
  }

  /** Counters over one session's retained events. */
  summary(sessionId) {
    return summarize(this.events(sessionId))
  }

  /** Counters over every session, plus per-session and per-project directories. */
  overview() {
    const entries = this.sessionIds().map((sessionId) => this.#sessions.get(sessionId))
    const sessions = entries.map((entry) => ({
      sessionId: entry.sessionId,
      project: entry.project || '',
      ...summarize(entry.events),
    }))
    const totals = summarize(entries.flatMap((entry) => entry.events))
    return { totals, sessions, projects: summarizeProjects(entries) }
  }

  /** Drop one session (used by the HTTP API's DELETE). */
  clear(sessionId) {
    const key = String(sessionId ?? 'unknown')
    const removed = this.#sessions.delete(key)
    try {
      this.#store?.remove(key)
    } catch {
      /* store reports its own failure */
    }
    return removed
  }

  /** Drop every retained session. */
  clearAll() {
    this.#sessions.clear()
    try {
      this.#store?.clear()
    } catch {
      /* store reports its own failure */
    }
  }
}

/** Sum session summaries into one row per project ('' = unknown project). */
function summarizeProjects(entries) {
  const byProject = new Map()
  for (const entry of entries) {
    const project = entry.project || ''
    let row = byProject.get(project)
    if (!row) {
      row = { project, sessions: 0, runs: 0, banks_authored: 0, certified_substitutions: 0, deferred: 0, selector_abstentions: 0, invalid_banks: 0, slow_tokens: 0, selector_tokens: 0, estimated_saved_tokens: 0, selector_tokens_lost: 0 }
      byProject.set(project, row)
    }
    const summary = summarize(entry.events)
    row.sessions += 1
    for (const key of ['runs', 'banks_authored', 'certified_substitutions', 'deferred', 'selector_abstentions', 'invalid_banks', 'slow_tokens', 'selector_tokens', 'estimated_saved_tokens', 'selector_tokens_lost']) {
      row[key] += summary[key]
    }
  }
  return [...byProject.values()].sort((a, b) => b.estimated_saved_tokens - a.estimated_saved_tokens)
}

/**
 * The savings walk: proxy each certificate's saving as the slow tokens of its
 * authoring turn minus the selector spend attributed to that substitution.
 * Selector spend that produced a fallback (abstention, error, unavailability)
 * or met a new slow call before a certificate is counted as lost, never saved.
 * Without a session log the slow tokens are 0, so the estimate is 0 — visible,
 * never invented.
 *
 * @param {Array<{at:number, kind:string, tokens?:number, usage?:{totalTokens?:number}}> | Array<Record<string, unknown>>} events
 * @returns {{savedTokens:number, lostTokens:number}}
 */
function savingsWalk(events) {
  let lastSlowTokens = 0
  let pendingSelector = 0
  let savedTokens = 0
  let lostTokens = 0
  for (const event of events) {
    if (event.kind === 'sar/slow-call') {
      if (pendingSelector > 0) {
        lostTokens += pendingSelector
        pendingSelector = 0
      }
      const tokens = Number(event.tokens ?? 0)
      if (tokens > 0) lastSlowTokens = tokens
    } else if (event.kind === 'jev/decision') {
      pendingSelector += Number(event.usage?.totalTokens ?? 0)
    } else if (event.kind === 'sar/substitution-certificate') {
      savedTokens += Math.max(0, lastSlowTokens - pendingSelector)
      pendingSelector = 0
    } else if (event.kind === 'jev/slow-fallback' || event.kind === 'jev/error') {
      lostTokens += pendingSelector
      pendingSelector = 0
    }
  }
  return { savedTokens, lostTokens }
}

/** Reduce an event stream to the counters the `/harnessmm` command reports. */
export function summarize(events) {
  const certificates = events.filter((event) => event.kind === 'sar/substitution-certificate')
  const authored = events.filter((event) => event.kind === 'sar/bank-authored')
  const deferred = events.filter((event) => event.kind === 'sar/defer')
  const fallbacks = events.filter((event) => event.kind === 'jev/slow-fallback')
  const invalid = events.filter((event) => event.kind === 'jev/invalid-bank')
  const runs = events.filter((event) => event.kind === 'harnessmm/run')
  const slowTokens = events.filter((event) => event.kind === 'sar/slow-call').reduce((total, event) => total + Number(event.tokens ?? 0), 0)
  const selectorTokens = events
    .filter((event) => event.kind === 'jev/decision')
    .reduce((total, event) => total + Number(event.usage?.totalTokens ?? 0), 0)
  const savings = savingsWalk(events)
  return {
    runs: runs.length,
    banks_authored: authored.length,
    certified_substitutions: certificates.length,
    deferred: deferred.length,
    selector_abstentions: fallbacks.length,
    invalid_banks: invalid.length,
    slow_tokens: slowTokens,
    selector_tokens: selectorTokens,
    estimated_saved_tokens: savings.savedTokens,
    selector_tokens_lost: savings.lostTokens,
    last_candidates: certificates.slice(-5).map((event) => String(event.candidate_id)),
  }
}

/**
 * Per-substitution savings rows for the dashboard: the command that ran without
 * a model call, the guard that authorized it, the exact native receipt and the
 * proxy token saving with its two inputs.
 *
 * @param {Array<Record<string, unknown>>} events
 */
export function substitutions(events) {
  const rows = []
  let lastSlowTokens = 0
  let pendingSelector = 0
  for (const event of events) {
    if (event.kind === 'sar/slow-call') {
      const tokens = Number(event.tokens ?? 0)
      if (tokens > 0) lastSlowTokens = tokens
      pendingSelector = 0
    } else if (event.kind === 'jev/decision') {
      pendingSelector += Number(event.usage?.totalTokens ?? 0)
    } else if (event.kind === 'jev/slow-fallback' || event.kind === 'jev/error') {
      pendingSelector = 0
    } else if (event.kind === 'sar/substitution-certificate') {
      let receipt = event.native_receipt?.observation
      try {
        if (typeof receipt === 'string') receipt = JSON.parse(receipt)
      } catch {
        /* keep the raw text */
      }
      rows.push({
        at: event.at,
        candidate_id: event.candidate_id,
        tool: event.exact_native_tool,
        command: event.exact_arguments?.command,
        guard: event.guard ?? null,
        return_code: receipt?.return_code ?? null,
        stdout: typeof receipt?.stdout === 'string' ? receipt.stdout.slice(0, 240) : '',
        bypassed_slow_callback_id: event.bypassed_slow_callback_id,
        bank_sha256: event.bank_sha256,
        slow_tokens: lastSlowTokens,
        selector_tokens: pendingSelector,
        saved_tokens: Math.max(0, lastSlowTokens - pendingSelector),
      })
      pendingSelector = 0
    }
  }
  return rows
}

/** The human-readable report the `/harnessmm` command prints. */
export function summaryText(summary, policy, project) {
  return [
    `harnessmm policy v${policy.version} (${policy.enabled ? 'enabled' : 'disabled'})`,
    `  runs: ${summary.runs}`,
    `  banks authored: ${summary.banks_authored}`,
    `  certified substitutions: ${summary.certified_substitutions}`,
    `  estimated saved: ${summary.estimated_saved_tokens} tok (authoring-turn slow tokens minus attributed selector spend)`,
    `  deferred to the model: ${summary.deferred}, selector abstentions: ${summary.selector_abstentions}`,
    `  invalid banks: ${summary.invalid_banks}`,
    `  slow tokens seen: ${summary.slow_tokens}, selector tokens spent: ${summary.selector_tokens} (lost: ${summary.selector_tokens_lost})`,
    project ? `  project: ${project}` : '  project: unknown',
    summary.last_candidates.length ? `  last: ${summary.last_candidates.join(', ')}` : '  last: none',
  ].join('\n')
}
