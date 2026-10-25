/** Minimal typed event emitter. */

export type Listener<T> = (payload: T) => void

export class Emitter<Events extends Record<string, unknown>> {
  private listeners = new Map<keyof Events, Set<Listener<never>>>()

  on<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(fn as Listener<never>)
    return () => set!.delete(fn as Listener<never>)
  }

  once<K extends keyof Events>(event: K, fn: Listener<Events[K]>): () => void {
    const off = this.on(event, (payload) => {
      off()
      fn(payload)
    })
    return off
  }

  emit<K extends keyof Events>(event: K, payload: Events[K]): void {
    const set = this.listeners.get(event)
    if (!set) return
    for (const fn of [...set]) {
      try {
        ;(fn as Listener<Events[K]>)(payload)
      } catch (err) {
        console.error('[graphwizz] listener error', err)
      }
    }
  }

  removeAll(): void {
    this.listeners.clear()
  }
}
