/**
 * Disk persistence for the HarnessMM ledger.
 *
 * One JSONL file, one record per event:
 *
 *   {"s":"<sessionId>","e":{"at":1762...,"kind":"sar/slow-call",...}}
 *
 * The ledger stays a pure in-memory reducer; this store only mirrors appended
 * events and reloads them at boot, so a restarted profile still shows the
 * savings it certified earlier. Every method is failure-tolerant: a read or
 * write error is reported through `describe()` and the plugin keeps working
 * with the in-memory ledger.
 *
 * Receipts and command text are part of a certificate, so persistence writes
 * them to the local profile storage (`~/.dsh/storages/harnessmm/ledger.jsonl`
 * by default). Set `persist: false` in the bundle config for memory-only.
 *
 * @module dsh-harnessmm/store
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

const MAX_BYTES = 16 * 1024 * 1024
const MAX_RECORDS = 20000

/** Resolve the configured path; '' means $DSH_HOME/storages/harnessmm/ledger.jsonl. */
export function resolveStoragePath(configured, env = process.env) {
  const home = env.DSH_HOME && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(homedir(), '.dsh')
  if (typeof configured !== 'string' || configured.length === 0) return join(home, 'storages', 'harnessmm', 'ledger.jsonl')
  if (configured === '~') return home
  if (configured.startsWith('~/') || configured.startsWith('~\\')) return join(home, configured.slice(2))
  return isAbsolute(configured) ? configured : join(home, configured)
}

/** One append-only JSONL store shared by every session of the profile. */
export class LedgerStore {
  #file
  #maxBytes
  #error = null
  #bytes = 0

  constructor(options = {}) {
    this.#file = typeof options.filePath === 'string' && options.filePath.length > 0 ? options.filePath : resolveStoragePath('')
    this.#maxBytes = Number.isSafeInteger(options.maxBytes) && options.maxBytes > 0 ? options.maxBytes : MAX_BYTES
    try {
      this.#bytes = existsSync(this.#file) ? statSync(this.#file).size : 0
    } catch {
      this.#bytes = 0
    }
  }

  get filePath() {
    return this.#file
  }

  /** Public status for `/api/dsh-harnessmm/status`; `error` is the last failure. */
  describe() {
    return { enabled: true, path: this.#file, error: this.#error, bytes: this.#bytes }
  }

  /**
   * Load every retained record grouped by session id, skipping malformed lines.
   * The newest MAX_RECORDS events win; the ledger applies its own per-session cap.
   *
   * @returns {Map<string, Array<Record<string, unknown>>>}
   */
  load() {
    const sessions = new Map()
    if (!existsSync(this.#file)) return sessions
    let text
    try {
      text = readFileSync(this.#file, 'utf8')
      this.#bytes = Buffer.byteLength(text)
      this.#error = null
    } catch (error) {
      this.#error = String(error && error.message ? error.message : error)
      return sessions
    }
    const records = []
    for (const line of text.split('\n')) {
      if (line.length === 0) continue
      let record
      try {
        record = JSON.parse(line)
      } catch {
        continue
      }
      if (!record || typeof record !== 'object') continue
      const sessionId = record.s
      const event = record.e
      if (typeof sessionId !== 'string' || sessionId.length === 0) continue
      if (!event || typeof event !== 'object' || Array.isArray(event)) continue
      if (typeof event.at !== 'number' || typeof event.kind !== 'string') continue
      records.push({ sessionId, event })
    }
    for (const record of records.slice(-MAX_RECORDS)) {
      let list = sessions.get(record.sessionId)
      if (!list) {
        list = []
        sessions.set(record.sessionId, list)
      }
      list.push(record.event)
    }
    return sessions
  }

  /** Mirror one event; never throws. */
  append(sessionId, event) {
    try {
      mkdirSync(dirname(this.#file), { recursive: true })
      const line = JSON.stringify({ s: String(sessionId), e: event })
      appendFileSync(this.#file, line + '\n')
      this.#bytes += Buffer.byteLength(line) + 1
      this.#error = null
      if (this.#bytes > this.#maxBytes) this.#compact()
    } catch (error) {
      this.#error = String(error && error.message ? error.message : error)
    }
  }

  /** Drop one session's persisted records. */
  remove(sessionId) {
    this.#rewrite((record) => record.s !== String(sessionId))
  }

  /** Drop every persisted record. */
  clear() {
    try {
      rmSync(this.#file, { force: true })
      this.#bytes = 0
      this.#error = null
    } catch (error) {
      this.#error = String(error && error.message ? error.message : error)
    }
  }

  /** Keep only the newest MAX_RECORDS lines (invoked when the file grows past the cap). */
  #compact() {
    try {
      const lines = readFileSync(this.#file, 'utf8').split('\n').filter((line) => line.length > 0)
      this.#write(lines.slice(-MAX_RECORDS))
    } catch (error) {
      this.#error = String(error && error.message ? error.message : error)
    }
  }

  /** Rewrite the file through a temp file, keeping records the predicate accepts. */
  #rewrite(predicate) {
    try {
      if (!existsSync(this.#file)) {
        this.#bytes = 0
        return
      }
      const kept = []
      for (const line of readFileSync(this.#file, 'utf8').split('\n')) {
        if (line.length === 0) continue
        let record
        try {
          record = JSON.parse(line)
        } catch {
          continue
        }
        if (record && typeof record === 'object' && typeof record.s === 'string' && predicate(record)) kept.push(line)
      }
      this.#write(kept)
      this.#error = null
    } catch (error) {
      this.#error = String(error && error.message ? error.message : error)
    }
  }

  #write(lines) {
    mkdirSync(dirname(this.#file), { recursive: true })
    const temp = `${this.#file}.${process.pid}.tmp`
    writeFileSync(temp, lines.length > 0 ? lines.join('\n') + '\n' : '')
    renameSync(temp, this.#file)
    this.#bytes = statSync(this.#file).size
  }
}
