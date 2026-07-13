import JSZip from 'jszip'
import Peer, { type DataConnection } from 'peerjs'
import type { ARProject } from '../types'
import { loadBlob, type ResolvedProject } from '../store/projects'

/**
 * "Share to phone" without publishing and without third-party storage.
 *
 * The editor opens a WebRTC peer (PeerJS + its free public signaling cloud)
 * and the QR encodes `#/view/shared?peer=<id>`. When the phone opens that
 * URL, the project (doc + model + compiled marker) streams directly from the
 * desktop browser to the phone — nothing is uploaded anywhere, it just
 * requires the editor tab to stay open while the phone loads.
 *
 * (A previous version uploaded a zip to tmpfiles.org; its download endpoint
 * sends no CORS headers, so browsers can never read the file. Direct P2P is
 * both more reliable and more private.)
 *
 * The viewer also still accepts `?src=<zip url>` for any CORS-accessible
 * hosted bundle (e.g. a published export).
 */

interface SharePayload {
  doc: ARProject
  model: ArrayBuffer
  mind?: ArrayBuffer
}

export interface ShareHost {
  /** URL to encode in the QR (viewer route with ?peer=). */
  url: string
  /** Number of devices served so far (updates via onUpdate). */
  stop: () => void
}

/** Editor side: host the current project over WebRTC. Resolves once the peer is ready. */
export async function hostShare(
  doc: ARProject,
  baseUrl: string,
  onUpdate: (status: string) => void,
): Promise<ShareHost> {
  const model = await loadBlob('model', doc.id)
  if (!model) throw new Error('Model file missing from local storage')
  const mind = await loadBlob('mind', doc.id)
  const payload: SharePayload = {
    doc,
    model: await model.arrayBuffer(),
    mind: mind ? await mind.arrayBuffer() : undefined,
  }

  const peer = new Peer()
  let served = 0

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Signaling server timeout — check the internet connection')), 15000)
    peer.on('open', () => {
      clearTimeout(timer)
      resolve()
    })
    peer.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })

  peer.on('connection', (conn: DataConnection) => {
    conn.on('open', () => {
      onUpdate(`sending to device ${served + 1}…`)
      conn.send({ type: 'project', doc: payload.doc, model: payload.model, mind: payload.mind })
    })
    conn.on('data', (d) => {
      const msg = d as { type?: string }
      if (msg?.type === 'received') {
        served++
        onUpdate(`delivered to ${served} device${served === 1 ? '' : 's'} — keep this tab open to share again`)
        conn.close()
      }
    })
  })
  peer.on('error', (e) => onUpdate(`share error: ${e.message ?? e}`))

  const url = `${baseUrl.replace(/\/?$/, '/')}#/view/shared?peer=${encodeURIComponent(peer.id)}`
  return { url, stop: () => peer.destroy() }
}

/** Viewer side: receive a project from a hosting editor. */
export async function resolvePeerProject(peerId: string): Promise<ResolvedProject | undefined> {
  const peer = new Peer()
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('signaling timeout')), 15000)
      peer.on('open', () => {
        clearTimeout(timer)
        resolve()
      })
      peer.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
    })

    const conn = peer.connect(peerId, { reliable: true })
    const payload = await new Promise<SharePayload>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('The sharing computer did not answer — is its editor tab still open?')),
        25000,
      )
      conn.on('data', (d) => {
        const msg = d as { type?: string } & SharePayload
        if (msg?.type === 'project' && msg.doc && msg.model) {
          clearTimeout(timer)
          conn.send({ type: 'received' })
          resolve({ doc: msg.doc, model: msg.model, mind: msg.mind })
        }
      })
      conn.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
      peer.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
    })

    const modelUrl = URL.createObjectURL(new Blob([payload.model]))
    const mindUrl = payload.mind ? URL.createObjectURL(new Blob([payload.mind])) : undefined
    // small delay so the 'received' ack flushes before we tear down
    setTimeout(() => peer.destroy(), 1500)
    return { doc: payload.doc, modelUrl, mindUrl, source: 'shared' }
  } catch (e) {
    peer.destroy()
    throw e
  }
}

/** Load a shared bundle zip from a CORS-accessible URL (secondary path). */
export async function resolveSharedProject(src: string): Promise<ResolvedProject | undefined> {
  const res = await fetch(src)
  if (!res.ok) return undefined
  const zip = await JSZip.loadAsync(await res.blob())
  // bundle may be flat or wrapped in a single folder — search for project.json
  const docEntry = zip.file(/(^|\/)project\.json$/)[0]
  if (!docEntry) return undefined
  const prefix = docEntry.name.slice(0, docEntry.name.length - 'project.json'.length)
  const doc = JSON.parse(await docEntry.async('string')) as ARProject

  const modelEntry = zip.file(prefix + doc.model)
  if (!modelEntry) return undefined
  const modelUrl = URL.createObjectURL(await modelEntry.async('blob'))

  const mindEntry = zip.file(prefix + 'targets.mind')
  const mindUrl = mindEntry ? URL.createObjectURL(await mindEntry.async('blob')) : undefined

  return { doc, modelUrl, mindUrl, source: 'shared' }
}

/** Build the exportable zip (still used by the publish flow helpers). */
export async function buildShareZip(doc: ARProject): Promise<Blob> {
  const zip = new JSZip()
  zip.file('project.json', JSON.stringify(doc))
  const model = await loadBlob('model', doc.id)
  if (!model) throw new Error('Model file missing from local storage')
  zip.file(doc.model, model)
  const mind = await loadBlob('mind', doc.id)
  if (mind) zip.file('targets.mind', mind)
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
}

/** Extract share parameters from a react-router location search string. */
export function sharedSrcFromSearch(search: string): string | null {
  return new URLSearchParams(search).get('src')
}

export function sharedPeerFromSearch(search: string): string | null {
  return new URLSearchParams(search).get('peer')
}
