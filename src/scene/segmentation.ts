import * as THREE from 'three'
import type { MeshSegmentation, SegmentDef } from '../types'

/**
 * Brush segmentation of a single mesh into "virtual parts".
 *
 * While painting, a PaintSession tracks a per-face segment id and shows live
 * feedback through vertex colors. On apply, the mask is stored as RLE runs in
 * the project doc, and `splitMeshBySegments` (called from loadModel) bakes the
 * mask into real separate meshes — so segments behave exactly like separate
 * models everywhere else (highlight, isolate, explode, labels, multi-card).
 *
 * Face order convention: the mesh's non-indexed triangle order (face i =
 * vertices 3i..3i+2). `ensureNonIndexed` establishes it deterministically.
 */

/** Convert to non-indexed in place; returns the face count. */
export function ensureNonIndexed(mesh: THREE.Mesh): number {
  if (mesh.geometry.index) mesh.geometry = mesh.geometry.toNonIndexed()
  return mesh.geometry.attributes.position.count / 3
}

export function facesToRuns(faceSeg: Uint16Array): [number, number][] {
  const runs: [number, number][] = []
  if (faceSeg.length === 0) return runs
  let cur = faceSeg[0]
  let len = 0
  for (let i = 0; i < faceSeg.length; i++) {
    if (faceSeg[i] === cur) len++
    else {
      runs.push([cur, len])
      cur = faceSeg[i]
      len = 1
    }
  }
  runs.push([cur, len])
  return runs
}

export function runsToFaces(seg: MeshSegmentation): Uint16Array {
  const out = new Uint16Array(seg.faceCount)
  let i = 0
  for (const [id, len] of seg.faceRuns) {
    out.fill(id, i, i + len)
    i += len
  }
  return out
}

const WHITE = new THREE.Color(1, 1, 1)

function colorMap(segments: SegmentDef[]): Map<number, THREE.Color> {
  const m = new Map<number, THREE.Color>()
  for (const s of segments) m.set(s.id, new THREE.Color(s.color))
  return m
}

export class PaintSession {
  readonly mesh: THREE.Mesh
  readonly faceCount: number
  faceSeg: Uint16Array

  /** Face centroids and normals in world space (model is static while painting). */
  private centroids: Float32Array
  private normals: Float32Array
  private colorAttr: THREE.BufferAttribute

  constructor(mesh: THREE.Mesh, existing?: MeshSegmentation) {
    this.mesh = mesh
    this.faceCount = ensureNonIndexed(mesh)
    this.faceSeg =
      existing && existing.faceCount === this.faceCount
        ? runsToFaces(existing)
        : new Uint16Array(this.faceCount)

    const geo = mesh.geometry
    const pos = geo.attributes.position
    this.colorAttr = new THREE.BufferAttribute(new Float32Array(pos.count * 3).fill(1), 3)
    geo.setAttribute('color', this.colorAttr)
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      ;(m as THREE.MeshStandardMaterial).vertexColors = true
      m.needsUpdate = true
    }

    mesh.updateWorldMatrix(true, false)
    const mw = mesh.matrixWorld
    this.centroids = new Float32Array(this.faceCount * 3)
    this.normals = new Float32Array(this.faceCount * 3)
    const a = new THREE.Vector3()
    const b = new THREE.Vector3()
    const c = new THREE.Vector3()
    const ab = new THREE.Vector3()
    const cb = new THREE.Vector3()
    for (let f = 0; f < this.faceCount; f++) {
      a.fromBufferAttribute(pos, f * 3).applyMatrix4(mw)
      b.fromBufferAttribute(pos, f * 3 + 1).applyMatrix4(mw)
      c.fromBufferAttribute(pos, f * 3 + 2).applyMatrix4(mw)
      this.centroids[f * 3] = (a.x + b.x + c.x) / 3
      this.centroids[f * 3 + 1] = (a.y + b.y + c.y) / 3
      this.centroids[f * 3 + 2] = (a.z + b.z + c.z) / 3
      ab.copy(a).sub(b)
      cb.copy(c).sub(b)
      cb.cross(ab).normalize()
      this.normals[f * 3] = cb.x
      this.normals[f * 3 + 1] = cb.y
      this.normals[f * 3 + 2] = cb.z
    }
  }

  private setFaceColor(f: number, color: THREE.Color) {
    const arr = this.colorAttr.array as Float32Array
    for (let v = 0; v < 3; v++) {
      const o = (f * 3 + v) * 3
      arr[o] = color.r
      arr[o + 1] = color.g
      arr[o + 2] = color.b
    }
  }

  /** Repaint all vertex colors from the current mask (call after seg edits). */
  repaintAll(segments: SegmentDef[]) {
    const map = colorMap(segments)
    for (let f = 0; f < this.faceCount; f++) {
      this.setFaceColor(f, map.get(this.faceSeg[f]) ?? WHITE)
    }
    this.colorAttr.needsUpdate = true
  }

  /**
   * Assign every face whose centroid lies within `radius` of `worldPoint` to
   * `segId` (0 erases). Unless `through`, faces looking away from the camera
   * ray are skipped so you don't paint the far side of the model.
   */
  paint(
    worldPoint: THREE.Vector3,
    radius: number,
    segId: number,
    segments: SegmentDef[],
    rayDir?: THREE.Vector3,
    through = false,
  ) {
    const map = colorMap(segments)
    const color = map.get(segId) ?? WHITE
    const r2 = radius * radius
    const { x, y, z } = worldPoint
    let changed = false
    for (let f = 0; f < this.faceCount; f++) {
      const dx = this.centroids[f * 3] - x
      const dy = this.centroids[f * 3 + 1] - y
      const dz = this.centroids[f * 3 + 2] - z
      if (dx * dx + dy * dy + dz * dz > r2) continue
      if (!through && rayDir) {
        const dot =
          this.normals[f * 3] * rayDir.x +
          this.normals[f * 3 + 1] * rayDir.y +
          this.normals[f * 3 + 2] * rayDir.z
        if (dot > 0) continue // back-facing relative to the view ray
      }
      if (this.faceSeg[f] !== segId) {
        this.faceSeg[f] = segId
        this.setFaceColor(f, color)
        changed = true
      }
    }
    if (changed) this.colorAttr.needsUpdate = true
  }

  /** Unassign every face of a segment (when the segment is deleted). */
  clearSegment(segId: number, segments: SegmentDef[]) {
    for (let f = 0; f < this.faceCount; f++) {
      if (this.faceSeg[f] === segId) this.faceSeg[f] = 0
    }
    this.repaintAll(segments)
  }

  /** Face counts per segment id (for the panel + pruning unused segments). */
  usage(): Map<number, number> {
    const m = new Map<number, number>()
    for (let f = 0; f < this.faceCount; f++) {
      m.set(this.faceSeg[f], (m.get(this.faceSeg[f]) ?? 0) + 1)
    }
    return m
  }
}

/**
 * Bake a mask into real meshes: one per painted segment plus one for the
 * remainder. Replaces `mesh` inside its parent. Attribute layout (uv, normal,
 * …) is preserved; the temporary paint color attribute is dropped.
 */
export function splitMeshBySegments(mesh: THREE.Mesh, seg: MeshSegmentation): THREE.Mesh[] {
  const faceCount = ensureNonIndexed(mesh)
  const faceSeg = seg.faceCount === faceCount ? runsToFaces(seg) : new Uint16Array(faceCount)
  const geo = mesh.geometry

  const facesById = new Map<number, number[]>()
  for (let f = 0; f < faceCount; f++) {
    let list = facesById.get(faceSeg[f])
    if (!list) facesById.set(faceSeg[f], (list = []))
    list.push(f)
  }

  const srcMaterial = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
  const nameById = new Map<number, string>()
  for (const s of seg.segments) nameById.set(s.id, s.name.trim() || `segment-${s.id}`)

  const result: THREE.Mesh[] = []
  for (const [id, faces] of facesById) {
    const sub = new THREE.BufferGeometry()
    for (const [key, attr] of Object.entries(geo.attributes)) {
      if (key === 'color') continue
      const src = attr as THREE.BufferAttribute
      const itemSize = src.itemSize
      const out = new Float32Array(faces.length * 3 * itemSize)
      const srcArr = src.array as Float32Array
      for (let i = 0; i < faces.length; i++) {
        const f = faces[i]
        out.set(srcArr.subarray(f * 3 * itemSize, (f + 1) * 3 * itemSize), i * 3 * itemSize)
      }
      sub.setAttribute(key, new THREE.BufferAttribute(out, itemSize))
    }
    const m = new THREE.Mesh(sub, (srcMaterial as THREE.Material).clone())
    ;(m.material as THREE.MeshStandardMaterial).vertexColors = false
    m.name = id === 0 ? `${mesh.name}_rest` : (nameById.get(id) ?? `segment-${id}`)
    m.position.copy(mesh.position)
    m.quaternion.copy(mesh.quaternion)
    m.scale.copy(mesh.scale)
    result.push(m)
  }

  const parent = mesh.parent
  if (parent) {
    for (const m of result) parent.add(m)
    parent.remove(mesh)
  }
  return result
}
