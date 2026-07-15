import JSZip from 'jszip'
import Peer, { type DataConnection } from 'peerjs'
import type { ARProject } from '../types'
import { loadBlob, loadExtraModel, type ResolvedProject } from '../store/projects'

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
  /** Morph-sequence objects, parallel to doc.extraModels. */
  extras?: ArrayBuffer[]
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

/**
 * Chunked transfer: a single huge message chokes the data channel on real
 * models (a brain GLB is tens of MB), so blobs are streamed in slices with
 * backpressure, and the receiver uses a stall-based timeout plus progress
 * reporting instead of one fixed deadline.
 */
// Two hard constraints from PeerJS internals:
// 1. Chunks stay under its 16 KB chunkedMTU (bigger messages get split and
//    the queue drains recursively — deep queues overflow the stack).
// 2. NOTHING with big arrays may pass through conn.send as an object:
//    binarypack's pack_array recurses ONCE PER ELEMENT, so a project doc with
//    painted masks (faceRuns can be 100k+ entries) overflows the stack on any
//    browser. The doc therefore travels as a JSON byte stream through the
//    same chunk pipe as the model.
const CHUNK_BYTES = 12 * 1024
const BUFFER_HIGH_WATER = 1024 * 1024

const mb = (n: number) => (n / 1048576).toFixed(1)

async function streamPayload(conn: DataConnection, payload: SharePayload, onUpdate: (s: string) => void) {
  const c = conn as unknown as { dataChannel?: RTCDataChannel; bufferSize?: number }
  const dc = c.dataChannel
  let sinceYield = 0
  const send = async (msg: unknown) => {
    // wait until PeerJS's own queue is empty AND the channel buffer is low
    while ((c.bufferSize ?? 0) > 0 || (dc ? dc.bufferedAmount : 0) > BUFFER_HIGH_WATER) {
      await new Promise((r) => setTimeout(r, 25))
    }
    conn.send(msg)
    // yield to the event loop periodically so the channel can actually drain
    if (++sinceYield >= 24) {
      sinceYield = 0
      await new Promise((r) => setTimeout(r, 0))
    }
  }

  const docBytes = new TextEncoder().encode(JSON.stringify(payload.doc))
  const streams: { which: string; buf: ArrayBuffer }[] = [
    { which: 'doc', buf: docBytes.buffer.slice(0, docBytes.byteLength) as ArrayBuffer },
    { which: 'model', buf: payload.model },
    ...(payload.mind ? [{ which: 'mind', buf: payload.mind }] : []),
    ...(payload.extras ?? []).map((buf, i) => ({ which: `extra${i}`, buf })),
  ]
  const total = streams.reduce((n, s) => n + s.buf.byteLength, 0)
  await send({ type: 'meta', streams: streams.map((s) => ({ which: s.which, size: s.buf.byteLength })) })

  let sent = 0
  let lastReport = 0
  for (const s of streams) {
    for (let o = 0; o < s.buf.byteLength; o += CHUNK_BYTES) {
      await send({ type: 'chunk', which: s.which, data: s.buf.slice(o, Math.min(o + CHUNK_BYTES, s.buf.byteLength)) })
      sent += Math.min(CHUNK_BYTES, s.buf.byteLength - o)
      if (sent - lastReport > 2 * 1024 * 1024) {
        lastReport = sent
        onUpdate(`sending… ${mb(sent)} / ${mb(total)} MB`)
      }
    }
  }
  await send({ type: 'eof' })
  onUpdate(`sent ${mb(total)} MB — waiting for the phone to confirm…`)
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
  const extras: ArrayBuffer[] = []
  for (let i = 0; i < (doc.extraModels?.length ?? 0); i++) {
    const b = await loadExtraModel(doc.id, doc.extraModels![i].key ?? i)
    if (b) extras.push(await b.arrayBuffer())
  }
  const payload: SharePayload = {
    doc,
    model: await model.arrayBuffer(),
    mind: mind ? await mind.arrayBuffer() : undefined,
    extras: extras.length ? extras : undefined,
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
      streamPayload(conn, payload, onUpdate).catch((e) => onUpdate(`send failed: ${e.message ?? e}`))
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
      // stall-based timeout: any message resets it, so big models get all the
      // time they need as long as bytes keep flowing
      let timer: number | undefined
      const arm = (ms: number, message: string) => {
        window.clearTimeout(timer)
        timer = window.setTimeout(() => reject(new Error(message)), ms)
      }
      arm(25000, 'The sharing computer did not answer — is its editor tab still open?')

      let meta: { streams: { which: string; size: number }[] } | null = null
      const parts = new Map<string, Uint8Array[]>()
      let received = 0
      let lastReport = 0
      const totalOf = () => meta?.streams.reduce((n, s) => n + s.size, 0) ?? 0

      const finish = () => {
        window.clearTimeout(timer)
        const concat = (which: string): ArrayBuffer | undefined => {
          const list = parts.get(which)
          if (!list) return undefined
          const size = list.reduce((n, c) => n + c.byteLength, 0)
          const out = new Uint8Array(size)
          let o = 0
          for (const c of list) {
            out.set(c, o)
            o += c.byteLength
          }
          return out.buffer
        }
        const docBuf = concat('doc')
        const model = concat('model')
        if (!docBuf || !model) {
          reject(new Error('Transfer ended before the project arrived — try scanning again.'))
          return
        }
        let doc: ARProject
        try {
          doc = JSON.parse(new TextDecoder().decode(docBuf)) as ARProject
        } catch {
          reject(new Error('The received project data is corrupted — try scanning again.'))
          return
        }
        const extras: ArrayBuffer[] = []
        for (let i = 0; ; i++) {
          const buf = concat(`extra${i}`)
          if (!buf) break
          extras.push(buf)
        }
        conn.send({ type: 'received' })
        resolve({ doc, model, mind: concat('mind'), extras: extras.length ? extras : undefined })
      }

      conn.on('open', () => onStatus?.('connected — waiting for the project…'))
      conn.on('iceStateChanged', (state) => {
        if (state === 'checking') onStatus?.('linking to the sharing computer… (negotiating route)')
        if (state === 'failed') {
          window.clearTimeout(timer)
          reject(
            new Error(
              'Direct connection failed — the networks block peer traffic. Put the phone on the same Wi-Fi as the computer and try again.',
            ),
          )
        }
      })
      conn.on('data', (d) => {
        arm(20000, 'The transfer stalled — check both devices stay awake and on the network, then rescan.')
        const msg = d as { type?: string } & Partial<SharePayload> & {
          streams?: { which: string; size: number }[]
          which?: string
          data?: ArrayBuffer | Uint8Array
        }
        if (msg?.type === 'project' && msg.doc && msg.model) {
          // legacy single-message sender (older desktop build)
          window.clearTimeout(timer)
          conn.send({ type: 'received' })
          resolve({ doc: msg.doc, model: msg.model, mind: msg.mind, extras: msg.extras })
          return
        }
        if (msg?.type === 'meta' && msg.streams) {
          meta = { streams: msg.streams }
          onStatus?.(`receiving the project… 0 / ${mb(totalOf())} MB`)
          return
        }
        if (msg?.type === 'chunk' && msg.which && msg.data) {
          const bytes = msg.data instanceof Uint8Array ? msg.data : new Uint8Array(msg.data)
          let list = parts.get(msg.which)
          if (!list) parts.set(msg.which, (list = []))
          list.push(bytes)
          received += bytes.byteLength
          if (received - lastReport > 1024 * 1024) {
            lastReport = received
            onStatus?.(`receiving the project… ${mb(received)} / ${mb(totalOf())} MB`)
          }
          return
        }
        if (msg?.type === 'eof') finish()
      })
      conn.on('error', (e) => {
        window.clearTimeout(timer)
        reject(e)
      })
      peer.on('error', (e) => {
        window.clearTimeout(timer)
        reject(e)
      })
    })

    const modelUrl = URL.createObjectURL(new Blob([payload.model]))
    const mindUrl = payload.mind ? URL.createObjectURL(new Blob([payload.mind])) : undefined
    const extras = payload.extras?.map((buf, i) => ({
      name: payload.doc.extraModels?.[i]?.name ?? `object ${i + 2}`,
      url: URL.createObjectURL(new Blob([buf])),
      file: payload.doc.extraModels?.[i]?.file ?? 'model.glb',
    }))
    // small delay so the 'received' ack flushes before we tear down
    setTimeout(() => peer.destroy(), 1500)
    return { doc: payload.doc, modelUrl, mindUrl, extras, source: 'shared' }
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

  const extras: { name: string; url: string; file: string }[] = []
  for (const m of doc.extraModels ?? []) {
    const entry = zip.file(prefix + m.file)
    if (entry) extras.push({ name: m.name, url: URL.createObjectURL(await entry.async('blob')), file: m.file })
  }

  return { doc, modelUrl, mindUrl, extras: extras.length ? extras : undefined, source: 'shared' }
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
  for (let i = 0; i < (doc.extraModels?.length ?? 0); i++) {
    const b = await loadExtraModel(doc.id, doc.extraModels![i].key ?? i)
    if (b) zip.file(doc.extraModels![i].file, b)
  }
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
}

/** Extract share parameters from a react-router location search string. */
export function sharedSrcFromSearch(search: string): string | null {
  return new URLSearchParams(search).get('src')
}

export function sharedPeerFromSearch(search: string): string | null {
  return new URLSearchParams(search).get('peer')
}
