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

/**
 * ICE config: STUN only. Same-network devices connect via host candidates and
 * most home NATs via STUN. There is deliberately no TURN: the old "openrelay"
 * free TURN is dead (probed: no relay candidates, just added latency). If
 * cross-network sharing behind strict NATs (e.g. phone on mobile data with
 * carrier CGNAT) is ever needed, add an account-based TURN service here.
 */
const PEER_CONFIG = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
    ],
  },
}

export interface ShareHost {
  /** URL to encode in the QR (viewer route with ?peer=). */
  url: string
  stop: () => void
}

/**
 * The active share lives at module level so it survives editor tab switches
 * and route changes — it only ends when the user starts a new share, clicks
 * stop, or closes/reloads the whole page.
 */
let activeShare: { docId: string; host: ShareHost; lastStatus: string } | null = null
const statusListeners = new Set<(s: string) => void>()

function pushStatus(s: string) {
  if (activeShare) activeShare.lastStatus = s
  for (const cb of statusListeners) cb(s)
}

/** Start sharing `doc` (stops any previous share). */
export async function startSharing(doc: ARProject, baseUrl: string): Promise<ShareHost> {
  activeShare?.host.stop()
  activeShare = null
  const host = await hostShare(doc, baseUrl, pushStatus)
  activeShare = { docId: doc.id, host, lastStatus: 'waiting for the phone to connect…' }
  pushStatus(activeShare.lastStatus)
  return host
}

export function stopSharing() {
  activeShare?.host.stop()
  activeShare = null
  pushStatus('sharing stopped')
}

/** Current share (if any) so a remounted panel can re-show the QR. */
export function getActiveShare(): { docId: string; url: string; lastStatus: string } | null {
  return activeShare ? { docId: activeShare.docId, url: activeShare.host.url, lastStatus: activeShare.lastStatus } : null
}

/** Subscribe to live status updates; returns an unsubscribe. */
export function onShareStatus(cb: (s: string) => void): () => void {
  statusListeners.add(cb)
  return () => statusListeners.delete(cb)
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

  const peer = new Peer(PEER_CONFIG)
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
    onUpdate('phone connecting…')
    conn.on('open', () => {
      onUpdate(`sending to device ${served + 1}…`)
      conn.send({ type: 'project', doc: payload.doc, model: payload.model, mind: payload.mind })
    })
    conn.on('data', (d) => {
      const msg = d as { type?: string }
      if (msg?.type === 'received') {
        served++
        onUpdate(`delivered to ${served} device${served === 1 ? '' : 's'} — keep this page open to share again`)
        conn.close()
      }
    })
    conn.on('iceStateChanged', (state) => {
      if (state === 'failed') onUpdate('a phone tried to connect but the direct link failed (network blocks peer traffic?)')
    })
  })
  // background-tab throttling can drop the signaling socket; reconnect so the
  // QR keeps working while the user does other things
  peer.on('disconnected', () => {
    onUpdate('reconnecting to signaling…')
    try {
      peer.reconnect()
    } catch {
      /* destroyed */
    }
  })
  peer.on('error', (e) => onUpdate(`share error: ${e.message ?? e}`))

  const url = `${baseUrl.replace(/\/?$/, '/')}#/view/shared?peer=${encodeURIComponent(peer.id)}`
  return { url, stop: () => peer.destroy() }
}

/** Viewer side: receive a project from a hosting editor. */
export async function resolvePeerProject(
  peerId: string,
  onStatus?: (s: string) => void,
): Promise<ResolvedProject | undefined> {
  const peer = new Peer(PEER_CONFIG)
  try {
    onStatus?.('contacting signaling server…')
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('signaling server timeout — check the internet connection')), 15000)
      peer.on('open', () => {
        clearTimeout(timer)
        resolve()
      })
      peer.on('error', (e) => {
        clearTimeout(timer)
        reject(e)
      })
    })

    onStatus?.('linking to the sharing computer…')
    const conn = peer.connect(peerId, { reliable: true })
    const payload = await new Promise<SharePayload>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('The sharing computer did not answer — is its editor tab still open?')),
        25000,
      )
      conn.on('open', () => onStatus?.('connected — receiving the project…'))
      conn.on('iceStateChanged', (state) => {
        if (state === 'checking') onStatus?.('linking to the sharing computer… (negotiating route)')
        if (state === 'failed') {
          clearTimeout(timer)
          reject(
            new Error(
              'Direct connection failed — the networks block peer traffic. Put the phone on the same Wi-Fi as the computer and try again.',
            ),
          )
        }
      })
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
