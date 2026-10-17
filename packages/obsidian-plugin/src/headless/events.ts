/**
 * The `Events` surface Obsidian's vault and metadata cache expose:
 * `on`, `off`, `offref`, `trigger`. A handler that throws is isolated so
 * one listener cannot break a write.
 */

export type EventRef = { name: string; fn: (...args: never[]) => unknown };

export class HeadlessEvents {
  private handlers = new Map<string, Set<EventRef>>();

  on(name: string, fn: (...args: never[]) => unknown): EventRef {
    const ref: EventRef = { name, fn };
    let set = this.handlers.get(name);
    if (!set) this.handlers.set(name, (set = new Set()));
    set.add(ref);
    return ref;
  }

  off(name: string, fn: (...args: never[]) => unknown): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const ref of set) if (ref.fn === fn) set.delete(ref);
  }

  offref(ref: EventRef): void {
    this.handlers.get(ref.name)?.delete(ref);
  }

  trigger(name: string, ...args: unknown[]): void {
    const set = this.handlers.get(name);
    if (!set) return;
    for (const ref of [...set]) {
      try {
        (ref.fn as (...a: unknown[]) => unknown)(...args);
      } catch {
        // A listener's failure is its own; the write that fired it stands.
      }
    }
  }

  tryTrigger = this.trigger.bind(this);
}
