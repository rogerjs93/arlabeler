import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { OBJLoader } from 'three/addons/loaders/OBJLoader.js'
import { STLLoader } from 'three/addons/loaders/STLLoader.js'
import type { MeshSegmentation, ModelFormat } from '../types'
import { splitMeshBySegments } from '../scene/segmentation'

/**
 * Real-world GLBs (Sketchfab exports etc.) are frequently Draco-compressed,
 * meshopt-compressed, or carry KTX2 GPU textures. Wire up all three decoders
 * (wasm files live in public/decoders/, copied from three's examples — re-copy
 * if the three version changes).
 */
let gltfLoader: GLTFLoader | null = null
function getGltfLoader(): GLTFLoader {
  if (gltfLoader) return gltfLoader
  const loader = new GLTFLoader()
  const draco = new DRACOLoader()
  draco.setDecoderPath(`${import.meta.env.BASE_URL}decoders/draco/`)
  loader.setDRACOLoader(draco)
  const ktx2 = new KTX2Loader()
  ktx2.setTranscoderPath(`${import.meta.env.BASE_URL}decoders/basis/`)
  // KTX2 needs renderer capabilities to pick a transcode target; a throwaway
  // renderer is fine (the real render contexts share the same GPU).
  try {
    const probe = new THREE.WebGLRenderer({ antialias: false })
    ktx2.detectSupport(probe)
    probe.dispose()
    loader.setKTX2Loader(ktx2)
  } catch {
    // no WebGL available (should not happen in a viewer) — skip KTX2 textures
  }
  loader.setMeshoptDecoder(MeshoptDecoder)
  gltfLoader = loader
  return loader
}

/** Translate loader errors into something a user can act on. */
function friendlyLoadError(e: unknown, format: ModelFormat): Error {
  const msg = e instanceof Error ? e.message : String(e)
  if (/external|\.bin|Failed to load buffer|Couldn't load texture/i.test(msg) && format === 'gltf') {
    return new Error(
      `This .gltf references separate files (.bin/textures) that aren't included. ` +
        `Re-export the model as a single .glb file and load that instead. (${msg})`,
    )
  }
  if (/DRACOLoader|KTX2Loader|meshopt/i.test(msg)) {
    return new Error(`The model uses a compression this build can't decode: ${msg}`)
  }
  return new Error(`Couldn't read the 3D model (${format}): ${msg}`)
}

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
  try {
    if (format === 'glb' || format === 'gltf') {
      const gltf = await getGltfLoader().parseAsync(buffer, url)
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
  } catch (e) {
    throw friendlyLoadError(e, format)
  }
}

/**
 * Load and normalize a model: center on origin, scale so the largest dimension
 * is 1. Labels store anchors in this normalized space, so they stay valid
 * regardless of the source file's units.
 */
export async function loadModel(
  source: Blob | string,
  format: ModelFormat,
  segmentation?: Record<string, MeshSegmentation>,
): Promise<LoadedModel> {
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

  nameMeshesUniquely(wrapper)

  // Bake painted masks into real meshes so segments act like separate parts.
  if (segmentation) {
    for (const [meshName, seg] of Object.entries(segmentation)) {
      if (!seg || seg.faceCount === 0) continue
      let target: THREE.Mesh | undefined
      wrapper.traverse((o) => {
        if (!target && (o as THREE.Mesh).isMesh && o.name === meshName) target = o as THREE.Mesh
      })
      if (target) splitMeshBySegments(target, seg)
    }
    nameMeshesUniquely(wrapper) // segment names are user-authored; dedupe again
    wrapper.updateWorldMatrix(true, true)
  }

  // Collect named parts (meshes).
  const parts: PartInfo[] = []
  wrapper.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const pbox = new THREE.Box3().setFromObject(mesh)
    const centroid = pbox.getCenter(new THREE.Vector3())
    // convert to wrapper-local (normalized) space
    wrapper.worldToLocal(centroid)
    parts.push({ name: mesh.name, mesh, centroid })
  })

  return { root: wrapper, parts, animations, format }
}

/** Give every mesh a unique, stable name (labels and masks reference names). */
function nameMeshesUniquely(root: THREE.Object3D) {
  const seen = new Map<string, number>()
  root.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    let name = mesh.name || mesh.parent?.name || 'part'
    const n = seen.get(name) ?? 0
    seen.set(name, n + 1)
    if (n > 0) name = `${name}_${n}`
    mesh.name = name
  })
}
