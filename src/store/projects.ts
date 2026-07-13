import { createStore, get, set, del, keys } from 'idb-keyval'
import type { ARProject } from '../types'

/**
 * Local project persistence (IndexedDB). A project occupies several keys:
 *   doc:<id>    -> ARProject (JSON document)
 *   model:<id>  -> Blob (the 3D model file)
 *   mind:<id>   -> Blob (compiled targets.mind), optional until compiled
 *   card:<id>   -> Blob (marker card PNG), optional until generated
 *
 * Published/sample projects live as static bundles under <site>/projects/<id>/
 * and are read-only; opening one in the editor clones it into IndexedDB.
 */
const store = createStore('arlabeler', 'projects')

export async function saveProjectDoc(doc: ARProject): Promise<void> {
  doc.updatedAt = Date.now()
  await set(`doc:${doc.id}`, doc, store)
}

export async function loadProjectDoc(id: string): Promise<ARProject | undefined> {
  return get(`doc:${id}`, store)
}

export async function saveBlob(kind: 'model' | 'mind' | 'card', id: string, blob: Blob): Promise<void> {
  await set(`${kind}:${id}`, blob, store)
}

export async function loadBlob(kind: 'model' | 'mind' | 'card', id: string): Promise<Blob | undefined> {
  return get(`${kind}:${id}`, store)
}

export async function deleteProject(id: string): Promise<void> {
  await Promise.all([
    del(`doc:${id}`, store),
    del(`model:${id}`, store),
    del(`mind:${id}`, store),
    del(`card:${id}`, store),
  ])
}

export async function listLocalProjects(): Promise<ARProject[]> {
  const allKeys = (await keys(store)) as string[]
  const docs: ARProject[] = []
  for (const k of allKeys) {
    if (typeof k === 'string' && k.startsWith('doc:')) {
      const doc = await get(k, store)
      if (doc) docs.push(doc as ARProject)
    }
  }
  return docs.sort((a, b) => b.updatedAt - a.updatedAt)
}

// ---- Published/static bundles (samples on the site, or exported projects) ----

/** Base URL for static project bundles, relative to the app (works on Pages subpaths). */
export function staticProjectUrl(id: string, file: string): string {
  return `${import.meta.env.BASE_URL}projects/${id}/${file}`
}

export interface SampleIndexEntry {
  id: string
  name: string
  description?: string
}

export async function listStaticProjects(): Promise<SampleIndexEntry[]> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}projects/index.json`)
    if (!res.ok) return []
    return (await res.json()) as SampleIndexEntry[]
  } catch {
    return []
  }
}

export async function loadStaticProjectDoc(id: string): Promise<ARProject | undefined> {
  try {
    const res = await fetch(staticProjectUrl(id, 'project.json'))
    if (!res.ok) return undefined
    return (await res.json()) as ARProject
  } catch {
    return undefined
  }
}

/**
 * Resolve a project for viewing: static bundle first (that is what a printed QR
 * points at), IndexedDB second (local editing/preview on this machine).
 * Returns the doc plus URLs/blobs for the model and .mind target.
 */
export interface ResolvedProject {
  doc: ARProject
  modelUrl: string
  mindUrl?: string
  source: 'static' | 'local' | 'shared'
}

export async function resolveProject(id: string): Promise<ResolvedProject | undefined> {
  const staticDoc = await loadStaticProjectDoc(id)
  if (staticDoc) {
    return {
      doc: staticDoc,
      modelUrl: staticProjectUrl(id, staticDoc.model),
      mindUrl: staticProjectUrl(id, 'targets.mind'),
      source: 'static',
    }
  }
  const doc = await loadProjectDoc(id)
  if (!doc) return undefined
  const modelBlob = await loadBlob('model', id)
  if (!modelBlob) return undefined
  const mindBlob = await loadBlob('mind', id)
  return {
    doc,
    modelUrl: URL.createObjectURL(modelBlob),
    mindUrl: mindBlob ? URL.createObjectURL(mindBlob) : undefined,
    source: 'local',
  }
}
