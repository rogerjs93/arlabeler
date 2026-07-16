import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { resolvePeerProject, resolveSharedProject, sharedPeerFromSearch, sharedSrcFromSearch } from '../share/tempShare'
import * as THREE from 'three'
import { MindARThree } from 'mind-ar/dist/mindar-image-three.prod.js'
import { resolveProject } from '../store/projects'
import { loadModel, formatFromFileName } from '../loaders/loadModel'
import { EffectsController } from '../scene/effects'
import { MorphSequence } from '../scene/morph'
import ViewerHud from '../components/ViewerHud'
import type { ARProject } from '../types'

type Status = 'loading' | 'starting' | 'scanning' | 'tracking' | 'error' | 'nomarker'

/**
 * The page a printed QR code opens. Runs MindAR image tracking and parents the
 * labeled model to the tracked card. Single-card, fold-up tent (anchor
 * hand-off between faces) and multi-card scenes are all driven by
 * doc.targets[].
 */
export default function ARView() {
  const { id } = useParams<{ id: string }>()
  const location = useLocation()
  const containerRef = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<Status>('loading')
  const [loadDetail, setLoadDetail] = useState('')
  const [errorMsg, setErrorMsg] = useState('')
  const [doc, setDoc] = useState<ARProject | null>(null)
  const [controller, setController] = useState<EffectsController | null>(null)
  const [selectedLabelId, setSelectedLabelId] = useState<string>()
  const [morphState, setMorphState] = useState<{ names: string[]; active: number; busy: boolean } | null>(null)
  const morphRef = useRef<MorphSequence | null>(null)
  const gesturesRef = useRef<{ reset: () => void } | null>(null)
  const stopRef = useRef<() => void>(() => {})

  useEffect(() => {
    if (!id || !containerRef.current) return
    let disposed = false
    const container = containerRef.current

    ;(async () => {
      const src = sharedSrcFromSearch(location.search)
      const peerId = sharedPeerFromSearch(location.search)
      if (peerId) setStatus('loading')
      const resolved = peerId
        ? await resolvePeerProject(peerId, setLoadDetail)
        : src
          ? await resolveSharedProject(src)
          : await resolveProject(id)
      setLoadDetail('')
      if (!resolved) {
        setStatus('error')
        setErrorMsg(
          src || peerId
            ? 'Shared project unavailable — make sure the sharing computer still has its editor tab open, then rescan the QR.'
            : 'Project not found at this address.',
        )
        return
      }
      setDoc(resolved.doc)
      if (!resolved.mindUrl) {
        setStatus('nomarker')
        return
      }
      // static bundles: verify targets.mind actually exists before MindAR eats a 404
      if (resolved.source === 'static') {
        const head = await fetch(resolved.mindUrl, { method: 'HEAD' })
        if (!head.ok) {
          setStatus('nomarker')
          return
        }
      }

      const format = formatFromFileName(resolved.doc.model)!
      const model = await loadModel(resolved.modelUrl, format, resolved.doc.segmentation)
      if (disposed) return

      const targets = resolved.doc.targets.length ? resolved.doc.targets : [{ index: 0, role: 'main' as const }]
      const isMultiCard = targets.some((t) => t.role === 'card')
      const isTent = targets.some((t) => t.role === 'face')

      const mindar = new MindARThree({
        container,
        imageTargetSrc: resolved.mindUrl,
        maxTrack: Math.min(targets.length, 3),
        uiLoading: 'no',
        uiScanning: 'no',
        uiError: 'no',
        filterMinCF: 0.0001,
        filterBeta: 0.001,
      })
      const { renderer, scene, camera } = mindar

      scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 1.2))
      const dir = new THREE.DirectionalLight(0xffffff, 1.4)
      dir.position.set(0.5, 1, 0.6)
      scene.add(dir)

      const t = resolved.doc.transform
      // 'upright' (default): card on a screen/wall or held up — model faces the
      // viewer, its up along the card's up. 'flat': card on a table — rotate so
      // the model's Y-up points out of the card and it stands on it.
      const flat = resolved.doc.cardOrientation === 'flat'

      // Build content per target. Single/tent share one content group that
      // hands off between visible anchors; multi-card gets a clone per card.
      const makeInner = () => {
        const container3 = new THREE.Group()
        if (flat) container3.rotation.x = Math.PI / 2
        const inner = new THREE.Group()
        // offset is authored in model space (x right, y up, z toward viewer);
        // container3's rotation already maps those axes onto the card.
        inner.position.set(t.offset[0], t.offset[1], t.offset[2])
        inner.rotation.set(t.rotation[0], t.rotation[1], t.rotation[2])
        inner.scale.setScalar(t.scale)
        container3.add(inner)
        return { container3, inner }
      }

      const controllers: EffectsController[] = []
      const anchors: { group: THREE.Group; visibleRef: { v: boolean } }[] = []
      const contentGroups: THREE.Group[] = [] // translated by two-finger drag
      let primary: EffectsController

      const introStyle = resolved.doc.introStyle ?? 'assemble'

      if (!isMultiCard) {
        primary = new EffectsController(model, resolved.doc.labels)
        primary.entranceStyle = introStyle
        controllers.push(primary)

        // morph sequence: primary + any extra objects (extras carry no labels)
        const morphItems = [{ controller: primary, name: resolved.doc.name }]
        for (const extra of resolved.extras ?? []) {
          const f = formatFromFileName(extra.file)
          if (!f) continue
          const em = await loadModel(extra.url, f)
          const ec = new EffectsController(em, [])
          ec.entranceStyle = introStyle
          controllers.push(ec)
          morphItems.push({ controller: ec, name: extra.name })
        }
        const morph = new MorphSequence(morphItems)
        morphRef.current = morph
        setMorphState({ names: morph.names, active: 0, busy: false })
        const content = morph.container
        contentGroups.push(content)

        const targetAnchors = targets.map((td) => {
          const anchor = mindar.addAnchor(td.index)
          const { container3, inner } = makeInner()
          anchor.group.add(container3)
          const visibleRef = { v: false }
          anchor.onTargetFound = () => {
            visibleRef.v = true
            if (!isTent || inner.children.length === 0) {
              // first find (or tent face hand-off handled in loop)
            }
            setStatus('tracking')
          }
          anchor.onTargetLost = () => {
            visibleRef.v = false
            if (!anchors.some((a) => a.visibleRef.v)) setStatus('scanning')
          }
          anchors.push({ group: anchor.group, visibleRef })
          return { anchor, inner, visibleRef }
        })

        // put content on the first anchor initially
        targetAnchors[0].inner.add(content)
        let currentHolder = targetAnchors[0]
        let entrancePlayed = false

        mindar.renderer.setAnimationLoop(() => {
          // tent: hand content to the first visible face
          if (isTent) {
            const vis = targetAnchors.find((a) => a.visibleRef.v)
            if (vis && vis !== currentHolder) {
              vis.inner.add(content)
              currentHolder = vis
            }
          }
          if (!entrancePlayed && targetAnchors.some((a) => a.visibleRef.v)) {
            entrancePlayed = true
            primary.playEntrance()
            if (resolved.doc.animation?.autoplay) primary.playClip(resolved.doc.animation.clip)
          }
          const active = morph.activeController
          updateDistance(active, currentHolder.anchor.group, camera)
          morph.update(clockDt(), camera)
          renderer.render(scene, camera)
        })
      } else {
        // multi-card: clone the model per card, show only assigned parts
        const cardTargets = targets
        let entrancePlayed = false
        for (const td of cardTargets) {
          const cloneRoot = model.root.clone(true)
          const cloneParts = collectParts(cloneRoot, model)
          const assigned = td.meshNames && td.meshNames.length > 0 ? new Set(td.meshNames) : null
          for (const p of cloneParts) p.mesh.visible = !assigned || assigned.has(p.name)
          const visibleParts = cloneParts.filter((p) => p.mesh.visible)
          const cardLabels = resolved.doc.labels.filter((l) =>
            assigned ? l.meshName && assigned.has(l.meshName) : !l.meshName || visibleParts.some((p) => p.name === l.meshName),
          )
          const ctl = new EffectsController(
            { root: cloneRoot, parts: visibleParts, animations: [], format: model.format },
            cardLabels,
          )
          ctl.entranceStyle = introStyle
          ctl.idleFloat = false
          controllers.push(ctl)

          const anchor = mindar.addAnchor(td.index)
          const { container3, inner } = makeInner()
          anchor.group.add(container3)
          const content = new THREE.Group()
          content.add(ctl.model.root, ctl.pinsGroup)
          inner.add(content)
          contentGroups.push(content)
          const visibleRef = { v: false }
          anchor.onTargetFound = () => {
            visibleRef.v = true
            setStatus('tracking')
            if (!entrancePlayed) {
              entrancePlayed = true
              controllers.forEach((c) => c.playEntrance())
            }
          }
          anchor.onTargetLost = () => {
            visibleRef.v = false
            if (!anchors.some((a) => a.visibleRef.v)) setStatus('scanning')
          }
          anchors.push({ group: anchor.group, visibleRef })
        }
        primary = controllers[0]

        mindar.renderer.setAnimationLoop(() => {
          const dt = clockDt()
          for (let i = 0; i < controllers.length; i++) {
            const c = controllers[i]
            if (c !== primary) {
              c.explode = primary.explode
              c.xray = primary.xray
              c.clipPaused = primary.clipPaused
              c.tourLabelId = primary.tourLabelId
            }
            updateDistance(c, anchors[i].group, camera)
            c.update(dt, camera)
          }
          renderer.render(scene, camera)
        })
      }

      setController(primary)

      // --- gestures: tap pick, drag rotate, two-finger scale + move ---
      gesturesRef.current = attachGestures(renderer.domElement, camera, controllers, contentGroups, flat, (labelId, meshName, double) => {
        if (labelId) setSelectedLabelId(labelId)
        else if (meshName) {
          if (double) {
            controllers.forEach((c) => c.setIsolated(c.isolatedMesh === meshName ? undefined : meshName))
          } else {
            const label = resolved.doc.labels.find((l) => l.meshName === meshName)
            setSelectedLabelId(label?.id)
          }
        }
      })

      setStatus('starting')
      try {
        await mindar.start()
        if (disposed) {
          mindar.stop()
          return
        }
        setStatus('scanning')
      } catch (e) {
        setStatus('error')
        const detail = e instanceof Error && e.message ? ` (${e.message})` : ''
        setErrorMsg(
          `Couldn't start the camera${detail}. AR needs camera permission and an HTTPS page (or localhost).`,
        )
        return
      }

      stopRef.current = () => {
        try {
          mindar.renderer.setAnimationLoop(null)
          mindar.stop()
        } catch { /* already stopped */ }
        controllers.forEach((c) => c.dispose())
      }
    })().catch((e) => {
      setStatus('error')
      setErrorMsg(String(e))
    })

    return () => {
      disposed = true
      stopRef.current()
      stopRef.current = () => {}
    }
  }, [id, location.search])

  return (
    <div style={{ position: 'relative', height: '100%', background: '#000' }}>
      {/* zIndex: 0 creates a stacking context: MindAR's camera <video> has
          z-index -2 and would otherwise paint behind the page background. */}
      <div ref={containerRef} style={{ position: 'absolute', inset: 0, overflow: 'hidden', zIndex: 0 }} />

      <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
        <Link to="/"><button>←</button></Link>
        <strong style={{ textShadow: '0 1px 4px #000' }}>{doc?.name ?? ''}</strong>
        <span className="badge" style={{ background: 'rgba(14,17,22,0.7)' }}>
          {status === 'tracking' ? '● tracking' : status === 'scanning' ? 'scanning…' : status}
        </span>
        <span className="badge" style={{ background: 'rgba(14,17,22,0.7)' }}>b {__BUILD__}</span>
      </div>

      {status === 'scanning' && (
        <div style={hintStyle}>Point the camera at the printed card</div>
      )}
      {status === 'starting' && <div style={hintStyle}>Starting camera…</div>}
      {status === 'loading' && <div style={hintStyle}>{loadDetail || 'Loading model…'}</div>}

      {(status === 'error' || status === 'nomarker') && doc && (
        <div style={{ ...hintStyle, top: '40%' }}>
          <div className="card" style={{ maxWidth: 420, textAlign: 'center' }}>
            <h3>{status === 'nomarker' ? 'No marker compiled yet' : 'AR unavailable'}</h3>
            <p className="muted small">
              {status === 'nomarker'
                ? 'Generate the marker card in the editor first.'
                : errorMsg}
            </p>
            <Link to={`/preview/${id}${location.search}`}><button className="primary">Open 3D preview instead</button></Link>
          </div>
        </div>
      )}
      {status === 'error' && !doc && (
        <div style={{ ...hintStyle, top: '40%' }}>
          <div className="card" style={{ maxWidth: 420, textAlign: 'center' }}>
            <h3>Couldn't load the project</h3>
            <p className="muted small">{errorMsg}</p>
            <Link to="/"><button>Home</button></Link>
          </div>
        </div>
      )}

      {doc && controller && (
        <ViewerHud
          doc={doc}
          controller={controller}
          selectedLabelId={selectedLabelId}
          onSelectLabel={setSelectedLabelId}
          morph={
            morphState && morphState.names.length > 1
              ? {
                  ...morphState,
                  onNext: () => {
                    const m = morphRef.current
                    if (!m) return
                    m.next()
                    setController(m.activeController)
                    setMorphState({ names: m.names, active: m.active, busy: m.isMorphing })
                  },
                }
              : undefined
          }
        >
          <button onClick={() => gesturesRef.current?.reset()} title="Undo touch moves: recenter, unscale, unrotate">
            ⌖ Recenter
          </button>
        </ViewerHud>
      )}
    </div>
  )
}

const hintStyle: React.CSSProperties = {
  position: 'absolute',
  top: 70,
  left: 0,
  right: 0,
  display: 'flex',
  justifyContent: 'center',
  zIndex: 9,
  color: '#fff',
  textShadow: '0 1px 4px #000',
  pointerEvents: 'none',
}

let lastTime = 0
function clockDt(): number {
  const now = performance.now() / 1000
  const dt = lastTime === 0 ? 0.016 : now - lastTime
  lastTime = now
  return Math.min(dt, 0.1)
}

function updateDistance(c: EffectsController, anchorGroup: THREE.Group, camera: THREE.Camera) {
  const v = new THREE.Vector3()
  anchorGroup.getWorldPosition(v)
  // MindAR camera sits at the origin; marker width = 1 world unit
  c.cameraDistance = v.distanceTo(camera.position)
}

/** Re-collect part infos from a cloned hierarchy (names were made unique at load). */
function collectParts(cloneRoot: THREE.Object3D, original: { parts: { name: string; centroid: THREE.Vector3 }[] }) {
  const byName = new Map(original.parts.map((p) => [p.name, p]))
  const parts: { name: string; mesh: THREE.Mesh; centroid: THREE.Vector3 }[] = []
  cloneRoot.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (mesh.isMesh && byName.has(mesh.name)) {
      parts.push({ name: mesh.name, mesh, centroid: byName.get(mesh.name)!.centroid.clone() })
    }
  })
  return parts
}

interface GestureApi {
  /** Undo all touch adjustments (rotation, scale, position). */
  reset: () => void
}

function attachGestures(
  el: HTMLElement,
  camera: THREE.Camera,
  controllers: EffectsController[],
  /** Groups translated by two-finger drag (the morph/content containers). */
  contents: THREE.Group[],
  /** Card orientation: maps the vertical finger axis onto the card plane. */
  flat: boolean,
  onPick: (labelId: string | undefined, meshName: string | undefined, double: boolean) => void,
): GestureApi {
  const raycaster = new THREE.Raycaster()
  const pointers = new Map<number, { x: number; y: number }>()
  let startPinch = 0
  let startScales: number[] = []
  let dragStartX = 0
  let dragging = false
  let startRotations: number[] = []
  let startMid = { x: 0, y: 0 }
  let startPositions: THREE.Vector3[] = []
  let lastTap = 0

  const roots = () => controllers.map((c) => c.model.root)
  const homePositions = contents.map((c) => c.position.clone())

  el.addEventListener('pointerdown', (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.size === 1) {
      dragStartX = e.clientX
      dragging = false
      startRotations = controllers.map((c) => c.userRotationY)
    } else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()]
      startPinch = Math.hypot(a.x - b.x, a.y - b.y)
      startScales = roots().map((r) => r.scale.x)
      startMid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      startPositions = contents.map((c) => c.position.clone())
      dragging = true // two-finger interaction is never a tap
    }
  })

  el.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.size === 1) {
      const dx = e.clientX - dragStartX
      if (Math.abs(dx) > 10) dragging = true
      if (dragging) {
        controllers.forEach((c, i) => (c.userRotationY = startRotations[i] + dx * 0.01))
      }
    } else if (pointers.size === 2 && startPinch > 0) {
      const [a, b] = [...pointers.values()]
      // pinch = scale
      const d = Math.hypot(a.x - b.x, a.y - b.y)
      const f = THREE.MathUtils.clamp(d / startPinch, 0.35, 3)
      roots().forEach((r, i) => r.scale.setScalar(startScales[i] * f))
      // two-finger drag = move along the card plane
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
      const k = 1.6 / Math.max(1, el.clientWidth) // full screen drag ≈ 1.6 card widths
      const mx = (mid.x - startMid.x) * k
      const my = (mid.y - startMid.y) * k
      contents.forEach((c, i) => {
        const p = startPositions[i]
        if (flat) {
          // card on a table: screen up = away from the viewer along the card
          c.position.set(
            THREE.MathUtils.clamp(p.x + mx, -1.5, 1.5),
            p.y,
            THREE.MathUtils.clamp(p.z + my, -1.5, 1.5),
          )
        } else {
          // upright card: screen up = up the card
          c.position.set(
            THREE.MathUtils.clamp(p.x + mx, -1.5, 1.5),
            THREE.MathUtils.clamp(p.y - my, -1.5, 1.5),
            p.z,
          )
        }
      })
    }
  })

  const endPointer = (e: PointerEvent) => {
    const start = pointers.get(e.pointerId)
    pointers.delete(e.pointerId)
    if (pointers.size < 2) startPinch = 0
    if (start && !dragging && pointers.size === 0) {
      // tap: pick pins/parts across all controllers
      const rect = el.getBoundingClientRect()
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      )
      raycaster.setFromCamera(ndc, camera)
      const now = performance.now()
      const double = now - lastTap < 320
      lastTap = now
      for (const c of controllers) {
        const hit = c.pick(raycaster)
        if (hit.labelId || hit.meshName) {
          onPick(hit.labelId, hit.meshName, double)
          return
        }
      }
    }
  }
  el.addEventListener('pointerup', endPointer)
  el.addEventListener('pointercancel', endPointer)

  return {
    reset: () => {
      controllers.forEach((c) => (c.userRotationY = 0))
      roots().forEach((r) => r.scale.setScalar(1))
      contents.forEach((c, i) => c.position.copy(homePositions[i]))
    },
  }
}
