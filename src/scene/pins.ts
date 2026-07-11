import * as THREE from 'three'
import type { Label } from '../types'

/**
 * Pin = numbered dot at the anchor + a floating title chip connected by a
 * leader line, all built from sprites so they billboard for free and work in
 * both the r3f preview and the raw-three MindAR viewer.
 */
export interface PinObject {
  label: Label
  group: THREE.Group
  chip: THREE.Sprite
  dot: THREE.Sprite
  line: THREE.Line
  /** Set by effects each frame; 0..1 visibility from LOD/tour dimming. */
  targetOpacity: number
  currentOpacity: number
  baseChipScale: THREE.Vector2
  /** Extra scale factor (proximity focus / tour). */
  emphasis: number
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function makeChipTexture(num: number, title: string, color: string): { tex: THREE.Texture; aspect: number } {
  const pad = 18
  const font = '500 34px "Segoe UI", system-ui, sans-serif'
  const numFont = '700 34px "Segoe UI", system-ui, sans-serif'
  const measure = document.createElement('canvas').getContext('2d')!
  measure.font = font
  const titleW = Math.min(measure.measureText(title).width, 460)
  const numW = 52
  const w = Math.ceil(pad + numW + 10 + titleW + pad)
  const h = 72
  const canvas = document.createElement('canvas')
  // 2x for crispness
  canvas.width = w * 2
  canvas.height = h * 2
  const ctx = canvas.getContext('2d')!
  ctx.scale(2, 2)

  ctx.fillStyle = 'rgba(13, 17, 24, 0.88)'
  roundRect(ctx, 1, 1, w - 2, h - 2, 16)
  ctx.fill()
  ctx.strokeStyle = color
  ctx.lineWidth = 2.5
  roundRect(ctx, 1.5, 1.5, w - 3, h - 3, 16)
  ctx.stroke()

  // number disc
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(pad + numW / 2 - 6, h / 2, 22, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = '#0b0e13'
  ctx.font = numFont
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(String(num), pad + numW / 2 - 6, h / 2 + 2)

  // title
  ctx.fillStyle = '#eef2f8'
  ctx.font = font
  ctx.textAlign = 'left'
  let t = title
  while (measure.measureText(t).width > 460 && t.length > 1) t = t.slice(0, -1)
  if (t !== title) t += '…'
  ctx.fillText(t, pad + numW + 4, h / 2 + 2)

  const tex = new THREE.CanvasTexture(canvas)
  tex.anisotropy = 4
  return { tex, aspect: w / h }
}

function makeDotTexture(color: string): THREE.Texture {
  const s = 64
  const canvas = document.createElement('canvas')
  canvas.width = s
  canvas.height = s
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.arc(s / 2, s / 2, 20, 0, Math.PI * 2)
  ctx.fill()
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'
  ctx.lineWidth = 5
  ctx.beginPath()
  ctx.arc(s / 2, s / 2, 20, 0, Math.PI * 2)
  ctx.stroke()
  return new THREE.CanvasTexture(canvas)
}

/** Build one pin. `num` is the 1-based visible number. */
export function createPin(label: Label, num: number, chipScale = 0.32): PinObject {
  const group = new THREE.Group()
  group.name = `pin:${label.id}`

  const anchor = new THREE.Vector3(...label.anchor)
  // chip floats outward from the model center through the anchor
  const outward = anchor.lengthSq() > 1e-6 ? anchor.clone().normalize() : new THREE.Vector3(0, 1, 0)
  const chipPos = anchor.clone().add(outward.multiplyScalar(0.22))

  const dot = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: makeDotTexture(label.color), depthTest: false, transparent: true }),
  )
  dot.position.copy(anchor)
  dot.scale.setScalar(0.045)
  dot.renderOrder = 998

  const { tex, aspect } = makeChipTexture(num, label.title || '(untitled)', label.color)
  const chip = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }))
  chip.position.copy(chipPos)
  const baseChipScale = new THREE.Vector2(chipScale * aspect * 0.28, chipScale * 0.28)
  chip.scale.set(baseChipScale.x, baseChipScale.y, 1)
  chip.renderOrder = 999
  chip.userData.labelId = label.id

  const lineGeo = new THREE.BufferGeometry().setFromPoints([anchor, chipPos])
  const line = new THREE.Line(
    lineGeo,
    new THREE.LineBasicMaterial({ color: new THREE.Color(label.color), transparent: true, opacity: 0.8, depthTest: false }),
  )
  line.renderOrder = 997

  group.add(line, dot, chip)
  return { label, group, chip, dot, line, targetOpacity: 1, currentOpacity: 1, baseChipScale, emphasis: 1 }
}

/** Smoothly apply opacity/emphasis each frame. */
export function updatePin(pin: PinObject, dt: number) {
  const k = 1 - Math.exp(-dt * 10)
  pin.currentOpacity += (pin.targetOpacity - pin.currentOpacity) * k
  const o = pin.currentOpacity
  ;(pin.chip.material as THREE.SpriteMaterial).opacity = o
  ;(pin.dot.material as THREE.SpriteMaterial).opacity = o
  ;(pin.line.material as THREE.LineBasicMaterial).opacity = o * 0.8
  pin.group.visible = o > 0.02

  const targetScale = pin.emphasis
  const sx = pin.baseChipScale.x * targetScale
  const sy = pin.baseChipScale.y * targetScale
  pin.chip.scale.x += (sx - pin.chip.scale.x) * k
  pin.chip.scale.y += (sy - pin.chip.scale.y) * k
}

export function disposePin(pin: PinObject) {
  ;(pin.chip.material as THREE.SpriteMaterial).map?.dispose()
  pin.chip.material.dispose()
  ;(pin.dot.material as THREE.SpriteMaterial).map?.dispose()
  pin.dot.material.dispose()
  pin.line.geometry.dispose()
  ;(pin.line.material as THREE.Material).dispose()
}
