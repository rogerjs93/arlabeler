import { useEffect, useRef, useState } from 'react'
import QRCode from 'qrcode'
import type { ARProject, TargetDef } from '../../types'
import { generateSingleCard, generateTentCard, generateMultiCardSet, canvasToBlob } from '../../marker/cardGenerator'
import { compileMindFile } from '../../marker/compileMind'
import { exportBundle, downloadBlob } from '../../marker/exportBundle'
import { getActiveShare, onShareStatus, startSharing, stopSharing } from '../../share/tempShare'
import { loadBlob, saveBlob } from '../../store/projects'

type MarkerMode = 'single' | 'tent' | 'multicard'

/**
 * Marker & Export tab: choose the card style, generate the printable card,
 * compile it into targets.mind (in-browser), download the print PNG and the
 * publishable bundle zip.
 */
export default function MarkerPanel({
  doc,
  updateDoc,
  partNames,
}: {
  doc: ARProject
  updateDoc: (patch: Partial<ARProject> | ((d: ARProject) => ARProject)) => void
  partNames: string[]
}) {
  const [baseUrl, setBaseUrl] = useState(
    () => localStorage.getItem('arlabeler:baseUrl') ?? 'https://rogerjs93.github.io/arlabeler/',
  )
  const [mode, setMode] = useState<MarkerMode>(() =>
    doc.targets.some((t) => t.role === 'card') ? 'multicard' : doc.markerStyle === 'tent' ? 'tent' : 'single',
  )
  const [cards, setCards] = useState<{ parts: string[] }[]>(() => {
    const cardTargets = doc.targets.filter((t) => t.role === 'card')
    return cardTargets.length > 0 ? cardTargets.map((t) => ({ parts: t.meshNames ?? [] })) : [{ parts: [] }, { parts: [] }]
  })
  const [phase, setPhase] = useState<'idle' | 'working' | 'done' | 'error'>('idle')
  const [progress, setProgress] = useState(0)
  const [message, setMessage] = useState('')
  const [cardUrl, setCardUrl] = useState<string>()
  const [share, setShare] = useState<{ state: 'idle' | 'working' | 'done' | 'error'; url?: string; error?: string; status?: string }>(() => {
    // an earlier share keeps running across tab switches — re-show its QR
    const active = getActiveShare()
    return active && active.docId === doc.id
      ? { state: 'done', url: active.url, status: active.lastStatus }
      : { state: 'idle' }
  })
  const shareQrRef = useRef<HTMLCanvasElement>(null)

  // live status updates from the running share (host keeps running on unmount)
  useEffect(
    () => onShareStatus((status) => setShare((s) => (s.state === 'done' ? { ...s, status } : s))),
    [],
  )

  useEffect(() => {
    localStorage.setItem('arlabeler:baseUrl', baseUrl)
  }, [baseUrl])

  // show existing card if one was generated before
  useEffect(() => {
    let url: string | undefined
    loadBlob('card', doc.id).then((b) => {
      if (b) {
        url = URL.createObjectURL(b)
        setCardUrl(url)
      }
    })
    return () => {
      if (url) URL.revokeObjectURL(url)
    }
  }, [doc.id])

  const viewerUrl = `${baseUrl.replace(/\/?$/, '/')}#/view/${doc.id}`
  const isLocalUrl = /localhost|127\.0\.0\.1/.test(baseUrl)

  const generate = async () => {
    setPhase('working')
    setProgress(0)
    setMessage('Drawing card…')
    try {
      const generated =
        mode === 'single'
          ? await generateSingleCard(doc.id, doc.name, viewerUrl)
          : mode === 'tent'
            ? await generateTentCard(doc.id, doc.name, viewerUrl)
            : await generateMultiCardSet(
                doc.id,
                doc.name,
                viewerUrl,
                cards.map((c, i) => (c.parts.length > 0 ? c.parts.join(', ') : `card ${i + 1}: full model`)),
              )

      setMessage('Compiling tracking targets… (this takes a moment)')
      const mindBlob = await compileMindFile(generated.targetCanvases, (p) => setProgress(Math.round(p)))
      const cardBlob = await canvasToBlob(generated.printCanvas)
      await saveBlob('mind', doc.id, mindBlob)
      await saveBlob('card', doc.id, cardBlob)

      const targets: TargetDef[] =
        mode === 'single'
          ? [{ index: 0, role: 'main' }]
          : mode === 'tent'
            ? [0, 1, 2].map((i) => ({ index: i, role: 'face' as const }))
            : cards.map((c, i) => ({ index: i, role: 'card' as const, meshNames: c.parts.length ? c.parts : undefined }))
      updateDoc((d) => ({ ...d, markerStyle: mode === 'tent' ? 'tent' : 'single', targets }))

      setCardUrl((old) => {
        if (old) URL.revokeObjectURL(old)
        return URL.createObjectURL(cardBlob)
      })
      setPhase('done')
      setMessage('Marker ready — print the card below.')
    } catch (e) {
      setPhase('error')
      setMessage(String(e))
    }
  }

  const download = async () => {
    const b = await loadBlob('card', doc.id)
    if (b) downloadBlob(b, `${doc.id}-card.png`)
  }

  const exportZip = async () => {
    try {
      const zip = await exportBundle(doc)
      downloadBlob(zip, `${doc.id}.zip`)
    } catch (e) {
      setMessage(String(e))
      setPhase('error')
    }
  }

  const shareToPhone = async () => {
    setShare({ state: 'working' })
    try {
      const host = await startSharing(doc, baseUrl)
      setShare({ state: 'done', url: host.url, status: 'waiting for the phone to connect…' })
    } catch (e) {
      setShare({ state: 'error', error: e instanceof Error ? e.message : String(e) })
    }
  }

  const stopShare = () => {
    stopSharing()
    setShare({ state: 'idle' })
  }

  // draw the share QR once its canvas is mounted
  useEffect(() => {
    if (share.state === 'done' && share.url && shareQrRef.current) {
      QRCode.toCanvas(shareQrRef.current, share.url, { width: 240, margin: 2 })
    }
  }, [share])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <section>
        <h3 className="small" style={sectionTitle}>Viewer address</h3>
        <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} style={{ width: '100%' }} />
        <div className="small muted" style={{ marginTop: 4, wordBreak: 'break-all' }}>
          QR opens: {viewerUrl}
        </div>
        {isLocalUrl && (
          <div className="small" style={{ color: 'var(--danger)', marginTop: 4 }}>
            localhost is not reachable from a phone — use your published site URL (or this PC's LAN IP during development).
          </div>
        )}
      </section>

      <section>
        <h3 className="small" style={sectionTitle}>Marker style</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label className="small"><input type="radio" checked={mode === 'single'} onChange={() => setMode('single')} /> Single flat card — simplest, print and go</label>
          <label className="small"><input type="radio" checked={mode === 'tent'} onChange={() => setMode('tent')} /> Fold-up tent (3 faces) — tracking survives walking around</label>
          <label className="small"><input type="radio" checked={mode === 'multicard'} onChange={() => setMode('multicard')} /> Multi-card scene — each card renders chosen parts</label>
        </div>
      </section>

      {mode === 'multicard' && (
        <section>
          <h3 className="small" style={sectionTitle}>Cards (max 3 tracked at once)</h3>
          {cards.map((c, i) => (
            <div key={i} className="card" style={{ padding: 8, marginBottom: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                <strong className="small">Card {i + 1}</strong>
                <span className="spacer" style={{ flex: 1 }} />
                {cards.length > 2 && (
                  <button className="danger small" style={{ padding: '2px 8px' }} onClick={() => setCards(cards.filter((_, j) => j !== i))}>remove</button>
                )}
              </div>
              <select
                multiple
                size={Math.min(partNames.length, 5)}
                value={c.parts}
                onChange={(e) =>
                  setCards(cards.map((cc, j) => (j === i ? { parts: [...e.target.selectedOptions].map((o) => o.value) } : cc)))
                }
                style={{ width: '100%' }}
              >
                {partNames.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
              <div className="small muted" style={{ marginTop: 2 }}>{c.parts.length === 0 ? 'whole model' : `${c.parts.length} part(s)`}</div>
            </div>
          ))}
          {cards.length < 3 && <button className="small" onClick={() => setCards([...cards, { parts: [] }])}>+ add card</button>}
        </section>
      )}

      <button className="primary" onClick={generate} disabled={phase === 'working'}>
        {phase === 'working' ? `${message} ${progress > 0 ? progress + '%' : ''}` : 'Generate card + compile tracking'}
      </button>
      {phase !== 'idle' && phase !== 'working' && (
        <div className="small" style={{ color: phase === 'error' ? 'var(--danger)' : 'var(--ok)' }}>{message}</div>
      )}

      <section>
        <h3 className="small" style={sectionTitle}>Share to phone (direct)</h3>
        <p className="small muted" style={{ margin: '0 0 8px' }}>
          Projects are saved in this browser only — another device can't see them. Sharing streams the
          project (model + labels + marker) <strong>directly from this computer to the phone</strong> over
          an encrypted peer connection; nothing is uploaded to any server.{' '}
          <strong>Put the phone on the same Wi-Fi as this computer</strong> (turn off mobile data if it
          keeps failing) and keep this page open. For a permanent link, export the bundle and publish it.
        </p>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={shareToPhone} disabled={share.state === 'working'}>
            {share.state === 'working' ? 'Connecting…' : share.state === 'done' ? '↻ New share link' : '📱 Share to phone'}
          </button>
          {share.state === 'done' && (
            <button className="danger" onClick={stopShare}>Stop sharing</button>
          )}
        </div>
        {share.state === 'error' && (
          <div className="small" style={{ color: 'var(--danger)', marginTop: 6 }}>
            Share failed: {share.error} — check the internet connection and try again, or publish instead.
          </div>
        )}
        {share.state === 'done' && share.url && (
          <div style={{ marginTop: 8, textAlign: 'center' }}>
            <canvas ref={shareQrRef} style={{ background: '#fff', borderRadius: 8, padding: 4 }} />
            <div className="small muted" style={{ wordBreak: 'break-all', marginTop: 4 }}>{share.url}</div>
            <button className="small" style={{ marginTop: 6 }} onClick={() => navigator.clipboard.writeText(share.url!)}>
              copy link
            </button>
            <p className="small" style={{ marginTop: 6, color: 'var(--ok)' }}>{share.status}</p>
            <p className="small muted" style={{ marginTop: 6 }}>
              Scan with the phone to open the AR viewer, then point it at the printed (or on-screen)
              marker card below. Sharing keeps running while you use the editor — it stops only when
              you press Stop, start a new share, or close this browser page.
            </p>
          </div>
        )}
      </section>

      {cardUrl && (
        <section>
          <h3 className="small" style={sectionTitle}>Printable card</h3>
          <img src={cardUrl} alt="marker card" style={{ width: '100%', borderRadius: 8, border: '1px solid var(--border)', background: '#fff' }} />
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button onClick={download}>Download PNG</button>
            <button onClick={exportZip}>Export bundle (zip)</button>
          </div>
          <p className="small muted" style={{ marginTop: 8 }}>
            Print at ~12 cm wide, matte paper if possible. To publish: unzip the bundle into <code>public/projects/</code> of
            the site, add the project to <code>projects/index.json</code>, and republish. The printed QR then works on any phone.
          </p>
        </section>
      )}
    </div>
  )
}

const sectionTitle: React.CSSProperties = { textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-dim)', marginBottom: 8 }
