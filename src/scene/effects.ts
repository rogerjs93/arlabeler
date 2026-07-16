import * as THREE from 'three'
import type { IntroStyle, Label } from '../types'
import type { LoadedModel, PartInfo } from '../loaders/loadModel'
import { createPin, disposePin, updatePin, type PinObject } from './pins'

/**
 * Drives all runtime behavior on a loaded model, shared by the non-AR preview
 * and the MindAR viewer: entrance animation, idle float, explode view,
 * isolate/X-ray, part highlighting, camera-distance label LOD, proximity
 * focus, baked clips and tour mode. Plain three.js — call `update(dt, camera)`
 * from whatever render loop hosts it.
 */

interface PartRuntime {
  info: PartInfo
  /** Explode direction expressed in the mesh's parent space. */
  explodeDir: THREE.Vector3
  basePosition: THREE.Vector3
  baseScale: THREE.Vector3
  /** Materials are cloned per-mesh at setup so per-part changes are safe. */
  material: THREE.Material | THREE.Material[]
  entranceDelay: number
}

export type HighlightMode = 'none' | 'highlight' | 'ghost'

/** Distance (in marker-card units) below which a label of rank r becomes visible. */
function lodDistanceForRank(rank: number): number {
  if (rank <= 0) return Infinity
  return [Infinity, 3.2, 2.3, 1.6, 1.1][Math.min(rank, 4)]
}

const easeOutBack = (t: number) => {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2)
}

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)

/** Total entrance duration per style, seconds. */
const INTRO_DURATION: Record<IntroStyle, number> = {
  assemble: 1.1,
  burst: 1.2,
  fade: 1.4,
  cascade: 1.5,
  spiral: 1.6,
  connections: 1.9,
}

export class EffectsController {
  readonly model: LoadedModel
  readonly labels: Label[]
  readonly pinsGroup = new THREE.Group()
  readonly pins: PinObject[] = []

  private parts: PartRuntime[] = []
  private mixer?: THREE.AnimationMixer
  private clipAction?: THREE.AnimationAction

  // state
  explode = 0
  xray = false
  isolatedMesh?: string
  highlightedMesh?: string
  tourLabelId?: string
  idleFloat = true
  turntable = false
  proximityFocus = true
  labelLod = true
  /** Camera distance in marker units; viewer feeds real pose, preview a slider. */
  cameraDistance = 2.5
  clipPaused = false
  /** Entrance animation style; set before playEntrance(). */
  entranceStyle: IntroStyle = 'assemble'
  /**
   * User-controlled extra Y rotation (touch drag in the viewer). Kept as its
   * own channel because update() re-derives root.rotation.y every frame —
   * writing to the root directly gets overwritten.
   */
  userRotationY = 0

  private entranceT = -1 // -1 = not playing, else 0..1
  private time = 0
  private focusedMesh?: string
  private baseRotationY: number
  private connectionLines?: THREE.LineSegments
  private tmpV = new THREE.Vector3()

  constructor(model: LoadedModel, labels: Label[]) {
    this.model = model
    this.labels = labels
    this.baseRotationY = model.root.rotation.y
    this.pinsGroup.name = '__pins__'

    model.root.updateWorldMatrix(true, true)
    const origin = new THREE.Vector3()
    model.parts.forEach((info, i) => {
      const mesh = info.mesh
      // clone materials so highlight/ghost per part never leaks across meshes
      const cloned = Array.isArray(mesh.material)
        ? mesh.material.map((m) => m.clone())
        : (mesh.material as THREE.Material).clone()
      for (const m of Array.isArray(cloned) ? cloned : [cloned]) {
        m.userData.__origTransparent = m.transparent
        m.userData.__origOpacity = m.opacity
      }
      mesh.material = cloned

      // explode direction: wrapper-space centroid direction, converted into the
      // mesh parent's local space (computed once; model-internal transforms are static)
      const parent = mesh.parent!
      const a = parent.worldToLocal(this.model.root.localToWorld(info.centroid.clone()))
      const b = parent.worldToLocal(this.model.root.localToWorld(origin.clone()))
      const dir = a.sub(b)

      this.parts.push({
        info,
        explodeDir: dir,
        basePosition: mesh.position.clone(),
        baseScale: mesh.scale.clone(),
        material: cloned,
        entranceDelay: (i / Math.max(1, model.parts.length)) * 0.45,
      })
    })

    this.rebuildPins()
    this.buildConnectionLines()

    if (model.animations.length > 0) {
      this.mixer = new THREE.AnimationMixer(model.root)
    }
  }

  /**
   * Glowing links between part centroids (greedy nearest-neighbor tree), shown
   * during the 'connections' intro to give a sense of how parts relate.
   */
  private buildConnectionLines() {
    const parts = this.model.parts
    if (parts.length < 2) return
    const connected = [0]
    const remaining = new Set<number>()
    for (let i = 1; i < parts.length; i++) remaining.add(i)
    const points: THREE.Vector3[] = []
    while (remaining.size > 0) {
      let bi = -1
      let bj = -1
      let bd = Infinity
      for (const j of remaining) {
        for (const i of connected) {
          const d = parts[i].centroid.distanceToSquared(parts[j].centroid)
          if (d < bd) {
            bd = d
            bi = i
            bj = j
          }
        }
      }
      points.push(parts[bi].centroid.clone(), parts[bj].centroid.clone())
      connected.push(bj)
      remaining.delete(bj)
    }
    const geo = new THREE.BufferGeometry().setFromPoints(points)
    const mat = new THREE.LineBasicMaterial({
      color: 0x4cc9ff,
      transparent: true,
      opacity: 0,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    this.connectionLines = new THREE.LineSegments(geo, mat)
    this.connectionLines.visible = false
    this.connectionLines.renderOrder = 995
    this.model.root.add(this.connectionLines)
  }

  /** (Re)build pin sprites from current labels — editor calls this after edits. */
  rebuildPins() {
    for (const p of this.pins) {
      this.pinsGroup.remove(p.group)
      disposePin(p)
    }
    this.pins.length = 0
    this.labels.forEach((label, i) => {
      const pin = createPin(label, i + 1)
      this.pins.push(pin)
      this.pinsGroup.add(pin.group)
    })
  }

  playClip(name?: string) {
    if (!this.mixer) return
    const clip = name
      ? this.model.animations.find((c) => c.name === name)
      : this.model.animations[0]
    if (!clip) return
    this.clipAction?.stop()
    this.clipAction = this.mixer.clipAction(clip)
    this.clipAction.play()
  }

  playEntrance() {
    this.entranceT = 0
  }

  setHighlight(meshName?: string) {
    this.highlightedMesh = meshName
  }

  setIsolated(meshName?: string) {
    this.isolatedMesh = meshName
  }

  setTourLabel(labelId?: string) {
    this.tourLabelId = labelId
    const label = this.labels.find((l) => l.id === labelId)
    this.setHighlight(label?.meshName)
  }

  /** Which part sits closest to the screen center right now (for focus + tap default). */
  get focused(): string | undefined {
    return this.focusedMesh
  }

  update(dt: number, camera: THREE.Camera) {
    this.time += dt
    dt = Math.min(dt, 0.1)

    // entrance
    if (this.entranceT >= 0) {
      this.entranceT = Math.min(1, this.entranceT + dt / INTRO_DURATION[this.entranceStyle])
      if (this.entranceT >= 1) this.entranceT = -1
    }

    // connection links glow during the 'connections' intro
    if (this.connectionLines) {
      const active = this.entranceStyle === 'connections' && this.entranceT >= 0
      this.connectionLines.visible = active
      if (active) {
        ;(this.connectionLines.material as THREE.LineBasicMaterial).opacity =
          Math.pow(Math.sin(Math.PI * this.entranceT), 0.7) * 0.9
      }
    }

    // idle float + turntable on the wrapper
    const root = this.model.root
    if (this.idleFloat) {
      root.position.y = Math.sin(this.time * 1.4) * 0.012
    }
    if (this.turntable) {
      root.rotation.y = this.baseRotationY + this.userRotationY + this.time * 0.35
    } else {
      root.rotation.y = this.baseRotationY + this.userRotationY
    }

    // proximity focus: part whose centroid projects nearest to screen center
    this.focusedMesh = undefined
    if (this.proximityFocus && this.parts.length > 1) {
      let best = 0.18 // NDC radius threshold
      const v = new THREE.Vector3()
      for (const p of this.parts) {
        v.copy(p.info.centroid)
        this.model.root.localToWorld(v)
        v.project(camera)
        if (v.z > 1) continue
        const d = Math.hypot(v.x, v.y)
        if (d < best) {
          best = d
          this.focusedMesh = p.info.name
        }
      }
    }

    // per-part transforms + materials
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i]
      const mesh = p.info.mesh

      // explode + entrance offsets
      const ex = this.explode
      mesh.position.copy(p.basePosition).addScaledVector(p.explodeDir, ex * 0.9)
      let scale = 1
      let alpha = 1
      if (this.entranceT >= 0) {
        const t = THREE.MathUtils.clamp((this.entranceT - p.entranceDelay) / 0.55, 0, 1)
        switch (this.entranceStyle) {
          case 'assemble':
            scale = t === 0 ? 0.0001 : easeOutBack(t)
            mesh.position.addScaledVector(p.explodeDir, (1 - t) * 0.6)
            break
          case 'burst': {
            // gathered at the center, then explodes outward with overshoot
            const e = t === 0 ? 0 : easeOutBack(t)
            mesh.position.addScaledVector(p.explodeDir, -(1 - e))
            scale = t === 0 ? 0.0001 : Math.min(1, 0.25 + 0.75 * e)
            break
          }
          case 'fade':
            alpha = easeOutCubic(t)
            mesh.position.y -= (1 - easeOutCubic(t)) * 0.07
            break
          case 'cascade':
            alpha = Math.min(1, t * 2.5)
            mesh.position.y += (1 - easeOutCubic(t)) * 0.9
            break
          case 'spiral': {
            const e = easeOutCubic(t)
            const ang = (1 - e) * Math.PI * 1.5
            const c = Math.cos(ang)
            const s = Math.sin(ang)
            const d = p.explodeDir
            const r = 1 + (1 - e) * 0.8 // swirl in from slightly outside
            this.tmpV.set(d.x * c - d.z * s, d.y, d.x * s + d.z * c).multiplyScalar(r).sub(d)
            mesh.position.add(this.tmpV)
            alpha = Math.min(1, t * 2)
            scale = 0.5 + 0.5 * e
            break
          }
          case 'connections':
            alpha = easeOutCubic(t)
            scale = t === 0 ? 0.0001 : 0.85 + 0.15 * easeOutBack(t)
            break
        }
      }
      mesh.scale.copy(p.baseScale).multiplyScalar(scale)

      // material mode
      let mode: HighlightMode = 'none'
      if (this.xray) mode = 'ghost'
      if (this.isolatedMesh && this.isolatedMesh !== p.info.name) mode = 'ghost'
      if (this.isolatedMesh === p.info.name) mode = 'none'
      if (this.highlightedMesh === p.info.name) mode = 'highlight'
      const focusGlow = this.focusedMesh === p.info.name && !this.highlightedMesh && mode === 'none'
      this.applyMaterialMode(p, mode, focusGlow, alpha)
    }

    // pins: LOD by camera distance, tour dimming, focus emphasis
    const tourLabel = this.tourLabelId
    for (let i = 0; i < this.pins.length; i++) {
      const pin = this.pins[i]
      const label = pin.label
      let visible = 1
      if (this.labelLod && this.cameraDistance > lodDistanceForRank(label.rank)) visible = 0
      if (tourLabel) visible = label.id === tourLabel ? 1 : 0.12
      if (this.isolatedMesh && label.meshName && label.meshName !== this.isolatedMesh) visible = Math.min(visible, 0.15)
      pin.targetOpacity = visible
      pin.emphasis =
        label.id === tourLabel || (label.meshName && label.meshName === this.focusedMesh) ? 1.45 : 1
      updatePin(pin, dt)
    }

    if (this.mixer && !this.clipPaused) this.mixer.update(dt)
  }

  private applyMaterialMode(p: PartRuntime, mode: HighlightMode, focusGlow: boolean, alpha = 1) {
    const mats = Array.isArray(p.material) ? p.material : [p.material]
    for (const m of mats) {
      const std = m as THREE.MeshStandardMaterial
      if (mode === 'ghost') {
        m.transparent = true
        m.opacity = 0.16
        m.depthWrite = false
      } else if (alpha < 1) {
        // entrance fade
        m.transparent = true
        m.opacity = (m.userData.__origOpacity ?? 1) * Math.max(alpha, 0.001)
        m.depthWrite = alpha > 0.6
      } else {
        m.transparent = m.userData.__origTransparent ?? false
        m.opacity = m.userData.__origOpacity ?? 1
        m.depthWrite = true
      }
      if (std.emissive) {
        if (mode === 'highlight') {
          std.emissive.setHex(0x4cc9ff)
          std.emissiveIntensity = 0.55
        } else if (focusGlow) {
          const pulse = 0.18 + Math.sin(this.time * 5) * 0.06
          std.emissive.setHex(0xffffff)
          std.emissiveIntensity = pulse
        } else {
          std.emissive.setHex(0x000000)
          std.emissiveIntensity = 1
        }
      }
    }
  }

  /** Raycast helper: which pin chip or part mesh is under the pointer. */
  pick(raycaster: THREE.Raycaster): { labelId?: string; meshName?: string } {
    const chipHits = raycaster.intersectObjects(this.pins.map((p) => p.chip), false)
    const visibleChip = chipHits.find((h) => (h.object as THREE.Sprite).material.opacity > 0.5)
    if (visibleChip) return { labelId: visibleChip.object.userData.labelId as string }
    const meshHits = raycaster.intersectObjects(this.parts.map((p) => p.info.mesh), false)
    for (const h of meshHits) {
      const mats = (h.object as THREE.Mesh).material
      const first = Array.isArray(mats) ? mats[0] : mats
      if (first.opacity > 0.5 || !first.transparent) return { meshName: h.object.name }
    }
    return {}
  }

  dispose() {
    for (const p of this.pins) disposePin(p)
    this.mixer?.stopAllAction()
    if (this.connectionLines) {
      this.connectionLines.geometry.dispose()
      ;(this.connectionLines.material as THREE.Material).dispose()
    }
  }
}
