// core/logger.js
// Non-blocking, leveled logger. Writes to an in-memory ring buffer
// and (optionally) console. Never throws.

const LEVELS = { trace: 10, debug: 20, info: 30, warn: 40, error: 50 };
const DEFAULT_LEVEL = LEVELS.info;

class Logger {
  constructor() {
    this._buffer = [];
    this._cap = 2000;
    this._level = DEFAULT_LEVEL;
    this._console = (typeof console !== 'undefined') && !!console.log;
    this._pending = [];
    this._flushScheduled = false;
  }

  setLevel(name) {
    if (LEVELS[name] != null) this._level = LEVELS[name];
  }

  /** Queue a log entry. Flush is scheduled via microtask to batch writes. */
  _log(level, tag, msg, ctx) {
    if (LEVELS[level] < this._level) return;
    this._pending.push({
      ts: Date.now(),
      level,
      tag,
      msg,
      ctx: ctx == null ? undefined : ctx
    });
    if (!this._flushScheduled) {
      this._flushScheduled = true;
      // Microtask flush — non-blocking to the caller, but ordered.
      Promise.resolve().then(() => this._flush());
    }
  }

  _flush() {
    this._flushScheduled = false;
    const items = this._pending;
    this._pending = [];
    for (const it of items) {
      this._buffer.push(it);
      if (this._buffer.length > this._cap) {
        this._buffer.splice(0, this._buffer.length - this._cap);
      }
      if (this._console) {
        const fn = (it.level === 'error' && console.error)
          ? console.error
          : (it.level === 'warn' && console.warn) ? console.warn : console.log;
        try {
          fn(`[${it.level}] ${it.tag}: ${it.msg}`,
            it.ctx != null ? it.ctx : '');
        } catch (_) { /* swallow */ }
      }
    }
  }

  trace(tag, msg, ctx) { this._log('trace', tag, msg, ctx); }
  debug(tag, msg, ctx) { this._log('debug', tag, msg, ctx); }
  info(tag, msg, ctx)  { this._log('info',  tag, msg, ctx); }
  warn(tag, msg, ctx)  { this._log('warn',  tag, msg, ctx); }
  error(tag, msg, ctx) { this._log('error', tag, msg, ctx); }

  /** Recent entries (oldest first). Optional level filter. */
  history(level) {
    if (!level) return this._buffer.slice();
    const thresh = LEVELS[level];
    return this._buffer.filter(e => LEVELS[e.level] >= thresh);
  }

  /** Drain buffer (used by tests / save-diagnostics). */
  flushSync() {
    if (this._flushScheduled) {
      this._flushScheduled = false;
      const items = this._pending;
      this._pending = [];
      for (const it of items) {
        this._buffer.push(it);
        if (this._buffer.length > this._cap) {
          this._buffer.splice(0, this._buffer.length - this._cap);
        }
      }
    }
  }
}

export const logger = new Logger();
