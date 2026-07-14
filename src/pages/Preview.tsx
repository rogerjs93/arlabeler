import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useLocation, useParams } from 'react-router-dom'
import { resolvePeerProject, resolveSharedProject, sharedPeerFromSearch, sharedSrcFromSearch } from '../share/tempShare'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, ContactShadows } from '@react-three/drei'
import { resolveProject, type ResolvedProject } from '../store/projects'
import { loadModel, formatFromFileName, type LoadedModel } from '../loaders/loadModel'
import { EffectsController } from '../scene/effects'
import { MorphSequence } from '../scene/morph'
import ViewerHud from '../components/ViewerHud'
import { PollingResizeObserver, needsPollingResize } from '../utils/pollingResizeObserver'

/**
 * Non-AR 3D preview: same model, pins and effects as the AR viewer, driven by
 * OrbitControls instead of a tracked marker. Doubles as the fallback when the
 * camera is unavailable. A debug slider simulates the phone-to-card distance
 * so the label-LOD behavior can be tested without AR.
 */
export default function Preview() {
  const { id } = useParams<{ id: string }>()
  const location = useLocation()
  const [resolved, setResolved] = useState<ResolvedProject | null>(null)
  const [model, setModel] = useState<LoadedModel | null>(null)
  const [extraModels, setExtraModels] = useState<{ name: string; model: LoadedModel }[]>([])
  const [error, setError] = useState<string>()
  const [selectedLabelId, setSelectedLabelId] = useState<string>()
  const [simDistance, setSimDistance] = useState<number | null>(null)
  const [morphTick, setMorphTick] = useState(0) // re-render when the active object changes
  const morphRef = useRef<MorphSequence | null>(null)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    ;(async () => {
      const src = sharedSrcFromSearch(location.search)
      const peerId = sharedPeerFromSearch(location.search)
      const r = peerId
        ? await resolvePeerProject(peerId)
        : src
          ? await resolveSharedProject(src)
          : await resolveProject(id)
      // (peer status detail is shown by ARView; preview just waits)
      if (!r) {
        setError(
          src || peerId
            ? 'Shared project unavailable — make sure the sharing computer still has its editor tab open, then rescan the QR.'
            : 'Project not found. It may only exist in another browser, or has not been published yet.',
        )
        return
      }
      const format = formatFromFileName(r.doc.model)
      if (!format) {
        setError(`Unknown model format: ${r.doc.model}`)
        return
      }
      const m = await loadModel(r.modelUrl, format, r.doc.segmentation)
      const loadedExtras: { name: string; model: LoadedModel }[] = []
      for (const extra of r.extras ?? []) {
        const f = formatFromFileName(extra.file)
        if (!f) continue
        loadedExtras.push({ name: extra.name, model: await loadModel(extra.url, f) })
      }
      if (cancelled) return
      setResolved(r)
      setModel(m)
      setExtraModels(loadedExtras)
    })().catch((e) => setError(String(e)))
    return () => {
      cancelled = true
      morphRef.current?.dispose()
      morphRef.current = null
    }
  }, [id, location.search])

  const morph = useMemo(() => {
    if (!model || !resolved) return null
    const primary = new EffectsController(model, resolved.doc.labels)
    if (import.meta.env.DEV) (window as unknown as { __ar: EffectsController }).__ar = primary
    primary.entranceStyle = resolved.doc.introStyle ?? 'assemble'
    if (resolved.doc.animation?.autoplay) primary.playClip(resolved.doc.animation.clip)
    primary.playEntrance()
    const items = [
      { controller: primary, name: resolved.doc.name },
      ...extraModels.map((e) => {
        const c = new EffectsController(e.model, [])
        c.entranceStyle = resolved.doc.introStyle ?? 'assemble'
        return { controller: c, name: e.name }
      }),
    ]
    const seq = new MorphSequence(items)
    morphRef.current = seq
    if (import.meta.env.DEV) (window as unknown as { __morph: MorphSequence }).__morph = seq
    return seq
  }, [model, resolved, extraModels])

  const controller = morph ? morph.activeController : null
  void morphTick // referenced so the state update forces re-render

  if (error) {
    return (
      <div className="app-shell" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div className="card" style={{ maxWidth: 460 }}>
          <h3>Cannot open preview</h3>
          <p className="muted">{error}</p>
          <Link to="/"><button>Home</button></Link>
        </div>
      </div>
    )
  }

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <div style={{ position: 'absolute', top: 12, left: 12, zIndex: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
        <Link to="/"><button>←</button></Link>
        <strong>{resolved?.doc.name ?? 'Loading…'}</strong>
        <span className="badge">3D preview</span>
      </div>

      {resolved && controller && morph && (
        <ViewerHud
          doc={resolved.doc}
          controller={controller}
          selectedLabelId={selectedLabelId}
          onSelectLabel={setSelectedLabelId}
          morph={
            morph.count > 1
              ? {
                  names: morph.names,
                  active: morph.active,
                  busy: morph.isMorphing,
                  onNext: () => {
                    morph.next()
                    setMorphTick((t) => t + 1)
                  },
                }
              : undefined
          }
        >
          <div className="card" style={{ padding: '8px 10px', width: 190 }}>
            <label className="small muted" style={{ display: 'block', marginBottom: 4 }}>
              Simulated distance {simDistance === null ? '(off — orbit zoom)' : `${simDistance.toFixed(1)}`}
            </label>
            <input
              type="range"
              min={0.5}
              max={4}
              step={0.1}
              value={simDistance ?? 2.5}
              onChange={(e) => setSimDistance(Number(e.target.value))}
              style={{ width: '100%' }}
            />
            {simDistance !== null && (
              <button className="small" style={{ marginTop: 6 }} onClick={() => setSimDistance(null)}>
                use orbit zoom
              </button>
            )}
          </div>
        </ViewerHud>
      )}

      <Canvas
        camera={{ position: [1.4, 1.0, 1.8], fov: 45 }}
        dpr={[1, 2]}
        onPointerMissed={() => setSelectedLabelId(undefined)}
        resize={needsPollingResize ? { polyfill: PollingResizeObserver as unknown as typeof ResizeObserver } : undefined}
      >
        <color attach="background" args={['#12151c']} />
        <hemisphereLight args={['#cfd8ea', '#3a4152', 1.1]} />
        <directionalLight position={[3, 5, 2]} intensity={1.6} />
        <directionalLight position={[-3, 2, -2]} intensity={0.5} />
        {controller && morph && (
          <SceneContent
            controller={controller}
            morph={morph}
            simDistance={simDistance}
            onPick={(labelId, meshName, double) => {
              if (labelId) setSelectedLabelId(labelId)
              else if (meshName) {
                if (double) {
                  controller.setIsolated(controller.isolatedMesh === meshName ? undefined : meshName)
                } else {
                  const label = controller.labels.find((l) => l.meshName === meshName)
                  setSelectedLabelId(label?.id)
                }
              }
            }}
          />
        )}
        <ContactShadows position={[0, -0.55, 0]} opacity={0.5} scale={4} blur={2.4} far={2} />
        <OrbitControls makeDefault enableDamping target={[0, 0, 0]} minDistance={0.7} maxDistance={6} />
      </Canvas>
    </div>
  )
}

function SceneContent({
  controller,
  morph,
  simDistance,
  onPick,
}: {
  controller: EffectsController
  morph: MorphSequence
  simDistance: number | null
  onPick: (labelId: string | undefined, meshName: string | undefined, double: boolean) => void
}) {
  const { camera, gl } = useThree()
  const raycaster = useMemo(() => new THREE.Raycaster(), [])
  const lastTap = useRef(0)

  useFrame((_, dt) => {
    controller.cameraDistance = simDistance ?? camera.position.length()
    morph.update(dt, camera)
  })

  useEffect(() => {
    const el = gl.domElement
    const onPointerDown = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect()
      const ndc = new THREE.Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      )
      raycaster.setFromCamera(ndc, camera)
      const hit = controller.pick(raycaster)
      const now = performance.now()
      const double = now - lastTap.current < 320
      lastTap.current = now
      if (hit.labelId || hit.meshName) onPick(hit.labelId, hit.meshName, double)
    }
    el.addEventListener('pointerdown', onPointerDown)
    return () => el.removeEventListener('pointerdown', onPointerDown)
  }, [gl, camera, controller, raycaster, onPick])

  return <primitive object={morph.container} />
}
