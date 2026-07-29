/**
 * Minimal, allocation-free event bus shared by every subsystem.
 * Handlers are stored in plain arrays; emit() never allocates.
 */
export class EventBus {
  constructor() {
    /** @type {Map<string, Function[]>} */
    this._map = new Map();
  }

  /**
   * @param {string} type
   * @param {(payload:any)=>void} fn
   * @returns {() => void} unsubscribe
   */
  on(type, fn) {
    let list = this._map.get(type);
    if (!list) {
      list = [];
      this._map.set(type, list);
    }
    list.push(fn);
    return () => this.off(type, fn);
  }

  once(type, fn) {
    const off = this.on(type, (payload) => {
      off();
      fn(payload);
    });
    return off;
  }

  off(type, fn) {
    const list = this._map.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }

  emit(type, payload) {
    const list = this._map.get(type);
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      try {
        list[i](payload);
      } catch (err) {
        console.error(`[EventBus] handler for "${type}" threw`, err);
      }
    }
  }

  clear() {
    this._map.clear();
  }
}

/** Application-wide singleton bus. */
export const bus = new EventBus();
