import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, ContactShadows } from '@react-three/drei'
import { resolveProject, type ResolvedProject } from '../store/projects'
import { loadModel, formatFromFileName, type LoadedModel } from '../loaders/loadModel'
import { EffectsController } from '../scene/effects'
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
  const [resolved, setResolved] = useState<ResolvedProject | null>(null)
  const [model, setModel] = useState<LoadedModel | null>(null)
  const [error, setError] = useState<string>()
  const [selectedLabelId, setSelectedLabelId] = useState<string>()
  const [simDistance, setSimDistance] = useState<number | null>(null)
  const controllerRef = useRef<EffectsController | null>(null)

  useEffect(() => {
    if (!id) return
    let cancelled = false
    ;(async () => {
      const r = await resolveProject(id)
      if (!r) {
        setError('Project not found. It may only exist in another browser, or has not been published yet.')
        return
      }
      const format = formatFromFileName(r.doc.model)
      if (!format) {
        setError(`Unknown model format: ${r.doc.model}`)
        return
      }
      const m = await loadModel(r.modelUrl, format, r.doc.segmentation)
      if (cancelled) return
      setResolved(r)
      setModel(m)
    })().catch((e) => setError(String(e)))
    return () => {
      cancelled = true
      controllerRef.current?.dispose()
      controllerRef.current = null
    }
  }, [id])

  const controller = useMemo(() => {
    if (!model || !resolved) return null
    const c = new EffectsController(model, resolved.doc.labels)
    controllerRef.current = c
    if (import.meta.env.DEV) (window as unknown as { __ar: EffectsController }).__ar = c
    if (resolved.doc.animation?.autoplay) c.playClip(resolved.doc.animation.clip)
    c.playEntrance()
    return c
  }, [model, resolved])

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

      {resolved && controller && (
        <ViewerHud
          doc={resolved.doc}
          controller={controller}
          selectedLabelId={selectedLabelId}
          onSelectLabel={setSelectedLabelId}
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
        {controller && (
          <SceneContent
            controller={controller}
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
  simDistance,
  onPick,
}: {
  controller: EffectsController
  simDistance: number | null
  onPick: (labelId: string | undefined, meshName: string | undefined, double: boolean) => void
}) {
  const { camera, gl } = useThree()
  const raycaster = useMemo(() => new THREE.Raycaster(), [])
  const lastTap = useRef(0)

  useFrame((_, dt) => {
    controller.cameraDistance = simDistance ?? camera.position.length()
    controller.update(dt, camera)
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

  return (
    <>
      <primitive object={controller.model.root} />
      <primitive object={controller.pinsGroup} />
    </>
  )
}
