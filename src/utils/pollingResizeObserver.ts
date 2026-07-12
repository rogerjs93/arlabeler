/**
 * ResizeObserver substitute for hidden/embedded documents.
 *
 * Native ResizeObserver delivers callbacks "before paint"; a document that is
 * permanently hidden (headless panes, some webviews) never paints, so r3f's
 * <Canvas> — which waits for its first measurement — never mounts its scene.
 * This polyfill measures immediately on observe() and then polls. Pass it to
 * <Canvas resize={{ polyfill: PollingResizeObserver }}> only when
 * `document.hidden` at mount; visible browsers keep the native observer.
 */
export class PollingResizeObserver {
  private cb: (entries: { target: Element; contentRect: DOMRectReadOnly }[]) => void
  private targets = new Map<Element, { w: number; h: number }>()
  private timer: number | undefined

  constructor(cb: (entries: { target: Element; contentRect: DOMRectReadOnly }[]) => void) {
    this.cb = cb
  }

  private measure(el: Element): DOMRectReadOnly {
    return el.getBoundingClientRect()
  }

  private tick = () => {
    const entries: { target: Element; contentRect: DOMRectReadOnly }[] = []
    for (const [el, last] of this.targets) {
      const rect = this.measure(el)
      if (rect.width !== last.w || rect.height !== last.h) {
        this.targets.set(el, { w: rect.width, h: rect.height })
        entries.push({ target: el, contentRect: rect })
      }
    }
    if (entries.length > 0) this.cb(entries)
  }

  observe(el: Element) {
    const rect = this.measure(el)
    this.targets.set(el, { w: rect.width, h: rect.height })
    // initial delivery, async like the real thing
    setTimeout(() => this.cb([{ target: el, contentRect: rect }]), 0)
    if (this.timer === undefined) {
      this.timer = window.setInterval(this.tick, 400)
    }
  }

  unobserve(el: Element) {
    this.targets.delete(el)
    if (this.targets.size === 0 && this.timer !== undefined) {
      window.clearInterval(this.timer)
      this.timer = undefined
    }
  }

  disconnect() {
    this.targets.clear()
    if (this.timer !== undefined) {
      window.clearInterval(this.timer)
      this.timer = undefined
    }
  }
}

/** True when the page loaded hidden — native RO/rAF will never deliver. */
export const needsPollingResize = typeof document !== 'undefined' && document.hidden
