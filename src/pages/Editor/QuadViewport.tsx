import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import type { EffectsController } from '../../scene/effects'
import type { ModelTransform } from '../../types'
import { PollingResizeObserver, needsPollingResize } from '../../utils/pollingResizeObserver'

/**
 * Four synchronized views of one scene rendered with scissored viewports:
 * perspective (orbit) + Front (Z), Side (X), Top (Y) orthographic views.
 * Clicking any view raycasts into the same scene, so labels can be placed
 * from whichever axis shows the anatomy best.
 */

export type EditorMode = 'select' | 'addLabel' | 'paint'

export interface PaintProps {
  /** The mesh being painted; strokes raycast only against it. */
  mesh: THREE.Mesh
  /** Brush radius in normalized model units (drives the indicator sphere). */
  radius: number
  /** Called for every stroke sample with the surface point and view ray. */
  onStroke: (worldPoint: THREE.Vector3, rayDir: THREE.Vector3) => void
}

export interface PickResult {
  labelId?: string
  meshName?: string
  /** Surface point in normalized model space (for placing pins). */
  point?: [number, number, number]
}

interface ViewDef {
  name: string
  kind: 'persp' | 'ortho'
  /** ortho: fixed view direction (camera sits on +axis looking at origin) */
  axis?: [number, number, number]
  up?: [number, number, number]
}

const VIEWS: ViewDef[] = [
  { name: 'Perspective', kind: 'persp' },
  { name: 'Front  ·  Z', kind: 'ortho', axis: [0, 0, 1], up: [0, 1, 0] },
  { name: 'Side  ·  X', kind: 'ortho', axis: [1, 0, 0], up: [0, 1, 0] },
  { name: 'Top  ·  Y', kind: 'ortho', axis: [0, 1, 0], up: [0, 0, -1] },
]

interface ViewState {
  // persp
  theta: number
  phi: number
  dist: number
  target: THREE.Vector3
  // ortho
  zoom: number
  pan: THREE.Vector2
}

export default function QuadViewport({
  controller,
  transform,
  orientation,
  mode,
  onPick,
  paint,
}: {
  controller: EffectsController | null
  transform: ModelTransform
  orientation: 'flat' | 'upright'
  mode: EditorMode
  onPick: (r: PickResult, view: string) => void
  paint?: PaintProps | null
}) {
  return (
    <div style={{ position: 'relative', width: '100%', height: '100%' }}>
      <Canvas
        frameloop="always"
        dpr={[1, 2]}
        gl={{ antialias: true }}
        style={{ background: '#0b0e13' }}
        resize={needsPollingResize ? { polyfill: PollingResizeObserver as unknown as typeof ResizeObserver } : undefined}
      >
        <hemisphereLight args={['#cfd8ea', '#3a4152', 1.1]} />
        <directionalLight position={[3, 5, 2]} intensity={1.5} />
        <directionalLight position={[-3, 2, -2]} intensity={0.5} />
        {controller && <primitive object={controller.model.root} />}
        {controller && <primitive object={controller.pinsGroup} />}
        <CardGhost transform={transform} orientation={orientation} />
        <gridHelper args={[3, 30, '#2a3242', '#1b2230']} position={[0, -0.501, 0]} />
        <MultiViewRenderer controller={controller} mode={mode} onPick={onPick} paint={paint} />
      </Canvas>
      {/* view captions + separators drawn over the canvas */}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
        <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: 'var(--border)' }} />
        <div style={{ position: 'absolute', top: '50%', left: 0, right: 0, height: 1, background: 'var(--border)' }} />
        {VIEWS.map((v, i) => (
          <span
            key={v.name}
            className="small muted"
            style={{
              position: 'absolute',
              left: i % 2 === 0 ? 10 : 'calc(50% + 10px)',
              top: i < 2 ? 8 : 'calc(50% + 8px)',
              textShadow: '0 1px 3px #000',
            }}
          >
            {v.name}
          </span>
        ))}
        {mode === 'addLabel' && (
          <div style={modeBanner}>Click the model to place the label</div>
        )}
        {mode === 'paint' && (
          <div style={modeBanner}>Drag on the model to paint · middle-drag/wheel to navigate</div>
        )}
      </div>
    </div>
  )
}

/**
 * Dashed outline showing where the printed marker card sits relative to the
 * model — horizontal (flat on a table) or vertical behind the model (upright).
 */
function CardGhost({ transform, orientation }: { transform: ModelTransform; orientation: 'flat' | 'upright' }) {
  const ref = useRef<THREE.Group>(null)
  useFrame(() => {
    const g = ref.current
    if (!g) return
    const s = transform.scale || 1
    // card center in model space = -offset/s ; card width 1 -> 1/s model units
    g.position.set(-transform.offset[0] / s, -transform.offset[1] / s, -transform.offset[2] / s)
    g.scale.setScalar(1 / s)
    g.rotation.x = orientation === 'flat' ? -Math.PI / 2 : 0
  })
  const geo = useMemo(() => {
    const g = new THREE.BufferGeometry()
    const h = 0.5
    g.setFromPoints([
      new THREE.Vector3(-h, -h, 0), new THREE.Vector3(h, -h, 0),
      new THREE.Vector3(h, h, 0), new THREE.Vector3(-h, h, 0),
      new THREE.Vector3(-h, -h, 0),
    ])
    return g
  }, [])
  return (
    <group ref={ref}>
      <lineLoop geometry={geo}>
        <lineBasicMaterial color="#4cc9ff" transparent opacity={0.7} />
      </lineLoop>
      <mesh>
        <planeGeometry args={[1, 1]} />
        <meshBasicMaterial color="#4cc9ff" transparent opacity={0.06} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
    </group>
  )
}

function MultiViewRenderer({
  controller,
  mode,
  onPick,
  paint,
}: {
  controller: EffectsController | null
  mode: EditorMode
  onPick: (r: PickResult, view: string) => void
  paint?: PaintProps | null
}) {
  const { gl, scene, size } = useThree()
  const modeRef = useRef(mode)
  modeRef.current = mode
  const paintRef = useRef(paint)
  paintRef.current = paint

  // brush indicator sphere (paint mode only)
  const brush = useMemo(() => {
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(1, 20, 14),
      new THREE.MeshBasicMaterial({ color: 0x4cc9ff, transparent: true, opacity: 0.28, depthWrite: false }),
    )
    m.visible = false
    m.renderOrder = 900
    return m
  }, [])
  useEffect(() => {
    scene.add(brush)
    return () => {
      scene.remove(brush)
      brush.geometry.dispose()
      ;(brush.material as THREE.Material).dispose()
    }
  }, [scene, brush])
  useEffect(() => {
    brush.visible = false
  }, [paint, brush])

  const cams = useMemo(
    () =>
      VIEWS.map((v) =>
        v.kind === 'persp'
          ? new THREE.PerspectiveCamera(45, 1, 0.01, 100)
          : new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100),
      ),
    [],
  )
  const states = useMemo<ViewState[]>(
    () =>
      VIEWS.map(() => ({
        theta: Math.PI / 4,
        phi: 1.1,
        dist: 2.6,
        target: new THREE.Vector3(0, 0, 0),
        zoom: 0.75,
        pan: new THREE.Vector2(0, 0),
      })),
    [],
  )

  const applyCamera = (i: number, aspect: number) => {
    const v = VIEWS[i]
    const cam = cams[i]
    const st = states[i]
    if (v.kind === 'persp') {
      const p = cam as THREE.PerspectiveCamera
      p.aspect = aspect
      const sp = new THREE.Vector3(
        st.dist * Math.sin(st.phi) * Math.cos(st.theta),
        st.dist * Math.cos(st.phi),
        st.dist * Math.sin(st.phi) * Math.sin(st.theta),
      )
      p.position.copy(st.target).add(sp)
      p.up.set(0, 1, 0)
      p.lookAt(st.target)
      p.updateProjectionMatrix()
    } else {
      const o = cam as THREE.OrthographicCamera
      const halfH = 0.9 / st.zoom
      const halfW = halfH * aspect
      o.left = -halfW + st.pan.x
      o.right = halfW + st.pan.x
      o.top = halfH + st.pan.y
      o.bottom = -halfH + st.pan.y
      const axis = new THREE.Vector3(...v.axis!)
      o.position.copy(axis.multiplyScalar(5))
      o.up.set(...(v.up as [number, number, number]))
      o.lookAt(0, 0, 0)
      o.updateProjectionMatrix()
    }
  }

  useFrame((_, dt) => {
    if (controller) {
      controller.idleFloat = false
      controller.labelLod = false
      controller.proximityFocus = false
      controller.update(dt, cams[0])
    }
    const w = Math.floor(size.width * gl.getPixelRatio())
    const h = Math.floor(size.height * gl.getPixelRatio())
    const cw = Math.floor(w / 2)
    const ch = Math.floor(h / 2)
    gl.setScissorTest(true)
    for (let i = 0; i < 4; i++) {
      const x = (i % 2) * cw
      const y = i < 2 ? ch : 0 // row 0 (top) first
      applyCamera(i, cw / ch)
      gl.setViewport(x, y, cw, ch)
      gl.setScissor(x, y, cw, ch)
      gl.render(scene, cams[i])
    }
    gl.setScissorTest(false)
  }, 1)

  // ---- input: per-cell orbit/pan/zoom + click picking ----
  useEffect(() => {
    const el = gl.domElement
    let down: { x: number; y: number; cell: number; button: number } | null = null
    let moved = false

    const cellAt = (e: PointerEvent | WheelEvent) => {
      const rect = el.getBoundingClientRect()
      const px = (e.clientX - rect.left) / rect.width
      const py = (e.clientY - rect.top) / rect.height
      const col = px < 0.5 ? 0 : 1
      const row = py < 0.5 ? 0 : 1
      return { cell: row * 2 + col, px, py, rect }
    }

    // raycast the paint mesh in whichever cell the pointer is over
    const paintHit = (e: PointerEvent): { point: THREE.Vector3; dir: THREE.Vector3 } | null => {
      const p = paintRef.current
      if (!p) return null
      const { cell, px, py } = cellAt(e)
      const lx = (px % 0.5) * 4 - 1
      const ly = -((py % 0.5) * 4 - 1)
      const rect = el.getBoundingClientRect()
      applyCamera(cell, rect.width / rect.height)
      cams[cell].updateMatrixWorld() // raycasting reads matrixWorld, not position
      const raycaster = new THREE.Raycaster()
      raycaster.setFromCamera(new THREE.Vector2(lx, ly), cams[cell])
      p.mesh.updateWorldMatrix(true, false)
      const hits = raycaster.intersectObject(p.mesh, false)
      if (hits.length === 0) return null
      return { point: hits[0].point, dir: raycaster.ray.direction.clone() }
    }

    let painting = false

    const onDown = (e: PointerEvent) => {
      const { cell } = cellAt(e)
      if (modeRef.current === 'paint' && e.button === 0) {
        painting = true
        try { el.setPointerCapture(e.pointerId) } catch { /* synthetic or stale pointer */ }
        const hit = paintHit(e)
        if (hit) paintRef.current?.onStroke(hit.point, hit.dir)
        return // left button paints; navigation stays on middle/shift
      }
      down = { x: e.clientX, y: e.clientY, cell, button: e.button }
      moved = false
      try { el.setPointerCapture(e.pointerId) } catch { /* synthetic or stale pointer */ }
    }

    const onMove = (e: PointerEvent) => {
      // brush indicator + stroke sampling in paint mode
      if (modeRef.current === 'paint' && paintRef.current) {
        const hit = paintHit(e)
        brush.visible = !!hit
        if (hit) {
          brush.position.copy(hit.point)
          brush.scale.setScalar(paintRef.current.radius)
          if (painting && e.buttons & 1) paintRef.current.onStroke(hit.point, hit.dir)
        }
      } else {
        brush.visible = false
      }
      if (!down) return
      const dx = e.clientX - down.x
      const dy = e.clientY - down.y
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true
      if (!moved) return
      const st = states[down.cell]
      const v = VIEWS[down.cell]
      if (v.kind === 'persp') {
        if (down.button === 1 || e.shiftKey) {
          // pan target
          const scale = st.dist * 0.0016
          const cam = cams[down.cell]
          const right = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 0)
          const up = new THREE.Vector3().setFromMatrixColumn(cam.matrix, 1)
          st.target.addScaledVector(right, -dx * scale).addScaledVector(up, dy * scale)
        } else {
          st.theta += dx * 0.008
          st.phi = THREE.MathUtils.clamp(st.phi - dy * 0.008, 0.08, Math.PI - 0.08)
        }
      } else {
        const scale = (0.9 / st.zoom) * 0.004
        // pan in camera plane: screen x -> camera right, screen y -> camera up
        st.pan.x -= dx * scale
        st.pan.y += dy * scale
      }
      down.x = e.clientX
      down.y = e.clientY
    }

    const onUp = (e: PointerEvent) => {
      if (painting) {
        painting = false
        try { el.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
        return
      }
      if (!down) return
      const wasMoved = moved
      const cell = down.cell
      down = null
      try { el.releasePointerCapture(e.pointerId) } catch { /* not captured */ }
      if (wasMoved || e.button !== 0 || !controller || modeRef.current === 'paint') return

      // click -> pick in that cell's camera
      const { px, py } = cellAt(e)
      const lx = (px % 0.5) * 4 - 1
      const ly = -((py % 0.5) * 4 - 1)
      const rect = el.getBoundingClientRect()
      applyCamera(cell, rect.width / rect.height) // aspect equal per cell (w/2)/(h/2)
      cams[cell].updateMatrixWorld() // raycasting reads matrixWorld, not position
      const raycaster = new THREE.Raycaster()
      raycaster.setFromCamera(new THREE.Vector2(lx, ly), cams[cell])

      if (modeRef.current === 'addLabel') {
        const meshes = controller.model.parts.map((p) => p.mesh)
        const hits = raycaster.intersectObjects(meshes, false)
        if (hits.length > 0) {
          const hit = hits[0]
          const local = controller.model.root.worldToLocal(hit.point.clone())
          onPick(
            { point: [local.x, local.y, local.z], meshName: hit.object.name },
            VIEWS[cell].name,
          )
        }
        return
      }
      const hit = controller.pick(raycaster)
      onPick(hit, VIEWS[cell].name)
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const { cell } = cellAt(e)
      const st = states[cell]
      const f = Math.exp(e.deltaY * 0.0012)
      if (VIEWS[cell].kind === 'persp') {
        st.dist = THREE.MathUtils.clamp(st.dist * f, 0.4, 12)
      } else {
        st.zoom = THREE.MathUtils.clamp(st.zoom / f, 0.15, 12)
      }
    }

    el.addEventListener('pointerdown', onDown)
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      el.removeEventListener('pointerdown', onDown)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('wheel', onWheel)
    }
  }, [gl, cams, states, controller, onPick, brush])

  return null
}

const modeBanner: React.CSSProperties = {
  position: 'absolute',
  top: 8,
  left: '50%',
  transform: 'translateX(-50%)',
  background: 'var(--accent)',
  color: '#0b0e13',
  fontWeight: 600,
  borderRadius: 8,
  padding: '4px 12px',
}
