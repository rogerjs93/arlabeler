import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import type { ModelFormat } from '../types'

export interface LoadedModel {
  /** Normalized: centered at origin, max dimension = 1, ready to parent anywhere. */
  root: THREE.Group
  /** Named meshes usable for label binding / highlighting. */
  parts: PartInfo[]
  animations: THREE.AnimationClip[]
  format: ModelFormat
}

export interface PartInfo {
  name: string
  mesh: THREE.Mesh
  /** Centroid in normalized model space (for explode view). */
  centroid: THREE.Vector3
}

export function formatFromFileName(name: string): ModelFormat | undefined {
  const ext = name.split('.').pop()?.toLowerCase()
  if (ext === 'glb' || ext === 'gltf') return ext
  if (ext === 'obj') return 'obj'
  if (ext === 'stl') return 'stl'
  return undefined
}

const STANDARD_MATERIAL = () =>
  new THREE.MeshStandardMaterial({ color: 0xb8bcc4, roughness: 0.65, metalness: 0.05 })

async function parseByFormat(buffer: ArrayBuffer, format: ModelFormat, url: string): Promise<{ root: THREE.Object3D; animations: THREE.AnimationClip[] }> {
  if (format === 'glb' || format === 'gltf') {
    const loader = new GLTFLoader()
    const gltf = await loader.parseAsync(buffer, url)
    return { root: gltf.scene, animations: gltf.animations ?? [] }
  }
  if (format === 'obj') {
    const text = new TextDecoder().decode(buffer)
    const root = new OBJLoader().parse(text)
    root.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).material = STANDARD_MATERIAL()
    })
    return { root, animations: [] }
  }
  // STL: single geometry, single mesh
  const geometry = new STLLoader().parse(buffer)
  geometry.computeVertexNormals()
  const mesh = new THREE.Mesh(geometry, STANDARD_MATERIAL())
  mesh.name = 'model'
  const group = new THREE.Group()
  group.add(mesh)
  return { root: group, animations: [] }
}

/**
 * Load and normalize a model: center on origin, scale so the largest dimension
 * is 1. Labels store anchors in this normalized space, so they stay valid
 * regardless of the source file's units.
 */
export async function loadModel(source: Blob | string, format: ModelFormat): Promise<LoadedModel> {
  let buffer: ArrayBuffer
  let url = ''
  if (typeof source === 'string') {
    url = source
    const res = await fetch(source)
    if (!res.ok) throw new Error(`Failed to fetch model: ${res.status}`)
    buffer = await res.arrayBuffer()
  } else {
    buffer = await source.arrayBuffer()
  }

  const { root: rawRoot, animations } = await parseByFormat(buffer, format, url)

  // Normalize into a wrapper group so the raw scene keeps its own transforms.
  const wrapper = new THREE.Group()
  wrapper.name = '__model_root__'
  wrapper.add(rawRoot)

  rawRoot.updateWorldMatrix(true, true)
  const box = new THREE.Box3().setFromObject(rawRoot)
  const size = box.getSize(new THREE.Vector3())
  const center = box.getCenter(new THREE.Vector3())
  const maxDim = Math.max(size.x, size.y, size.z) || 1
  const s = 1 / maxDim
  rawRoot.scale.multiplyScalar(s)
  rawRoot.position.set(-center.x * s, -center.y * s, -center.z * s)

  wrapper.updateWorldMatrix(true, true)

  // Collect named parts (meshes). Ensure unique, stable names.
  const parts: PartInfo[] = []
  const seen = new Map<string, number>()
  wrapper.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    let name = mesh.name || mesh.parent?.name || 'part'
    const n = seen.get(name) ?? 0
    seen.set(name, n + 1)
    if (n > 0) name = `${name}_${n}`
    mesh.name = name

    const pbox = new THREE.Box3().setFromObject(mesh)
    const centroid = pbox.getCenter(new THREE.Vector3())
    // convert to wrapper-local (normalized) space
    wrapper.worldToLocal(centroid)
    parts.push({ name, mesh, centroid })
  })

  return { root: wrapper, parts, animations, format }
}
