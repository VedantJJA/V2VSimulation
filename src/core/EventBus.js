/**
 * EventBus — minimal synchronous pub/sub.
 *
 * Usage:
 *   const off = bus.on('player:jump', (payload) => { ... });
 *   bus.emit('player:jump', { height: 2 });
 *   off(); // unsubscribe
 *
 * Notes:
 * - `on` returns an unsubscribe function (the handler can also be removed
 *   directly with `off`).
 * - A handler that throws is logged and skipped — one bad subscriber never
 *   breaks the emit chain.
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
  }

  /**
   * Subscribe `handler` to `event`.
   * @param {string} event
   * @param {Function} handler
   * @returns {() => void} unsubscribe function
   */
  on(event, handler) {
    if (typeof handler !== 'function') {
      throw new TypeError(`EventBus.on: handler for "${event}" must be a function`);
    }
    let listeners = this._listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this._listeners.set(event, listeners);
    }
    listeners.add(handler);
    return () => this.off(event, handler);
  }

  /** Unsubscribe `handler` from `event`. Safe if not subscribed. */
  off(event, handler) {
    const listeners = this._listeners.get(event);
    if (!listeners) return;
    listeners.delete(handler);
    if (listeners.size === 0) this._listeners.delete(event);
  }

  /** Emit `event` with an optional payload. Synchronous. */
  emit(event, payload) {
    const listeners = this._listeners.get(event);
    if (!listeners) return;
    // Copy so handlers can unsubscribe (themselves or others) mid-emit.
    for (const handler of [...listeners]) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`EventBus: handler for "${event}" threw`, error);
      }
    }
  }

  /** Remove all subscriptions. */
  clear() {
    this._listeners.clear();
  }
}