import * as THREE from 'three'
import type { EffectsController } from './effects'

/**
 * Morph sequence between whole objects: object 1 morphs into object 2, then 3…
 * The transition is a swirl crossover — the outgoing object spins and shrinks
 * to nothing while the incoming one spins up in its place (true vertex
 * morphing between arbitrary meshes isn't generally possible; this is the
 * presentation-style equivalent).
 *
 * Each item is wrapped in its own group so the swirl never fights the
 * controller's own root animations (idle float, turntable). Only the active
 * item's controller is updated each frame (both during a transition).
 */

const DURATION = 1.2

interface MorphItem {
  controller: EffectsController
  name: string
  wrap: THREE.Group
}

export class MorphSequence {
  readonly container = new THREE.Group()
  private items: MorphItem[] = []
  private activeIdx = 0
  private fromIdx = -1
  private t = -1 // -1 = idle, else 0..1 transition progress

  constructor(items: { controller: EffectsController; name: string }[]) {
    this.container.name = '__morph__'
    this.items = items.map(({ controller, name }) => {
      const wrap = new THREE.Group()
      wrap.add(controller.model.root, controller.pinsGroup)
      return { controller, name, wrap }
    })
    if (this.items.length > 0) this.container.add(this.items[0].wrap)
  }

  get names(): string[] {
    return this.items.map((i) => i.name)
  }

  get active(): number {
    return this.activeIdx
  }

  get activeController(): EffectsController {
    return this.items[this.activeIdx].controller
  }

  get count(): number {
    return this.items.length
  }

  get isMorphing(): boolean {
    return this.t >= 0
  }

  next() {
    if (this.items.length < 2) return
    this.goTo((this.activeIdx + 1) % this.items.length)
  }

  goTo(index: number) {
    if (index === this.activeIdx || this.t >= 0 || !this.items[index]) return
    this.fromIdx = this.activeIdx
    this.activeIdx = index
    this.t = 0
    const incoming = this.items[index]
    incoming.wrap.scale.setScalar(0.0001)
    this.container.add(incoming.wrap)
  }

  update(dt: number, camera: THREE.Camera) {
    if (this.items.length === 0) return

    if (this.t >= 0) {
      this.t = Math.min(1, this.t + dt / DURATION)
      const from = this.items[this.fromIdx]
      const to = this.items[this.activeIdx]
      const half = 0.5
      if (this.t < half) {
        // outgoing swirls away
        const k = this.t / half
        const e = 1 - Math.pow(1 - k, 2)
        from.wrap.scale.setScalar(Math.max(0.0001, 1 - e))
        from.wrap.rotation.y = e * Math.PI * 2
        to.wrap.scale.setScalar(0.0001)
      } else {
        // incoming swirls in
        const k = (this.t - half) / half
        const e = 1 - Math.pow(1 - k, 3)
        from.wrap.scale.setScalar(0.0001)
        to.wrap.scale.setScalar(Math.max(0.0001, e))
        to.wrap.rotation.y = (1 - e) * -Math.PI * 2
      }
      if (this.t >= 1) {
        this.container.remove(from.wrap)
        from.wrap.scale.setScalar(1)
        from.wrap.rotation.y = 0
        to.wrap.scale.setScalar(1)
        to.wrap.rotation.y = 0
        this.t = -1
        this.fromIdx = -1
      }
    }

    // drive the visible controllers
    this.items[this.activeIdx].controller.update(dt, camera)
    if (this.fromIdx >= 0 && this.fromIdx !== this.activeIdx) {
      this.items[this.fromIdx].controller.update(dt, camera)
    }
  }

  /** Propagate viewer settings (explode, xray, distance…) to all controllers. */
  forEach(fn: (c: EffectsController) => void) {
    for (const i of this.items) fn(i.controller)
  }

  dispose() {
    for (const i of this.items) i.controller.dispose()
  }
}
