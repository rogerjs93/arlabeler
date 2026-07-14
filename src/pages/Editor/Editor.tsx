import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import type { ARProject, Label } from '../../types'
import { DEFAULT_TRANSFORM, FLAT_TRANSFORM, INTRO_STYLES, LABEL_COLORS, newLabelId, newProjectId } from '../../types'
import {
  deleteExtraModel,
  loadBlob,
  loadProjectDoc,
  loadStaticProjectDoc,
  saveBlob,
  saveExtraModel,
  saveProjectDoc,
  staticProjectUrl,
} from '../../store/projects'
import { loadModel, formatFromFileName, type LoadedModel } from '../../loaders/loadModel'
import { EffectsController } from '../../scene/effects'
import { getActiveShare, onShareStatus } from '../../share/tempShare'
import { PaintSession, facesToRuns } from '../../scene/segmentation'
import QuadViewport, { type EditorMode, type PickResult } from './QuadViewport'
import MarkerPanel from './MarkerPanel'
import PaintPanel, { type PaintState } from './PaintPanel'

export default function Editor() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [doc, setDoc] = useState<ARProject | null>(null)
  const [model, setModel] = useState<LoadedModel | null>(null)
  const [error, setError] = useState<string>()
  const [selectedLabelId, setSelectedLabelId] = useState<string>()
  const [hoverPart, setHoverPart] = useState<string>()
  const [mode, setMode] = useState<EditorMode>('select')
  const [tab, setTab] = useState<'labels' | 'marker'>('labels')
  const [paint, setPaint] = useState<PaintState | null>(null)
  const [shareActive, setShareActive] = useState(() => !!getActiveShare())
  const saveTimer = useRef<number | undefined>(undefined)
  const modelBlobRef = useRef<Blob | null>(null)

  // little topbar indicator so a running share is visible from any tab
  useEffect(() => onShareStatus(() => setShareActive(!!getActiveShare())), [])

  // ---- load (cloning a static sample into a new local project if needed) ----
  useEffect(() => {
    if (!id) return
    let cancelled = false
    ;(async () => {
      let d = await loadProjectDoc(id)
      let modelBlob = d ? await loadBlob('model', id) : undefined
      if (!d || !modelBlob) {
        const staticDoc = await loadStaticProjectDoc(id)
        if (!staticDoc) {
          setError('Project not found.')
          return
        }
        // clone sample -> new local project with its own id (and QR)
        const newId = newProjectId()
        const res = await fetch(staticProjectUrl(id, staticDoc.model))
        if (!res.ok) {
          setError('Sample model file missing.')
          return
        }
        modelBlob = await res.blob()
        d = { ...staticDoc, id: newId, name: `${staticDoc.name} (copy)`, createdAt: Date.now(), updatedAt: Date.now() }
        await saveBlob('model', newId, modelBlob)
        await saveProjectDoc(d)
        if (!cancelled) navigate(`/editor/${newId}`, { replace: true })
        return
      }
      const format = formatFromFileName(d.model)
      if (!format) {
        setError(`Unknown model format: ${d.model}`)
        return
      }
      const m = await loadModel(modelBlob, format, d.segmentation)
      if (cancelled) return
      modelBlobRef.current = modelBlob
      setDoc(d)
      setModel(m)
    })().catch((e) => setError(String(e)))
    return () => {
      cancelled = true
    }
  }, [id, navigate])

  const controller = useMemo(() => {
    if (!model) return null
    return new EffectsController(model, [])
  }, [model])
  useEffect(() => () => controller?.dispose(), [controller])

  // keep controller labels/pins in sync with doc
  useEffect(() => {
    if (!controller || !doc) return
    controller.labels.length = 0
    controller.labels.push(...doc.labels)
    controller.rebuildPins()
  }, [controller, doc])

  // highlight: hovered part wins, else the selected label's bound part
  useEffect(() => {
    if (!controller || !doc) return
    const sel = doc.labels.find((l) => l.id === selectedLabelId)
    controller.setHighlight(hoverPart ?? sel?.meshName)
  }, [controller, doc, hoverPart, selectedLabelId])

  const updateDoc = useCallback((patch: Partial<ARProject> | ((d: ARProject) => ARProject)) => {
    setDoc((d) => {
      if (!d) return d
      const next = typeof patch === 'function' ? patch(d) : { ...d, ...patch }
      window.clearTimeout(saveTimer.current)
      saveTimer.current = window.setTimeout(() => saveProjectDoc(next), 400)
      return next
    })
  }, [])

  const updateLabel = (labelId: string, patch: Partial<Label>) =>
    updateDoc((d) => ({ ...d, labels: d.labels.map((l) => (l.id === labelId ? { ...l, ...patch } : l)) }))

  // ---- brush segmentation ----
  // Painting operates on the UNSPLIT mesh (masks are defined over its face
  // order), so entering paint mode reloads the model without segmentation and
  // apply/cancel reload it with the (new) masks baked into real parts.
  useEffect(() => {
    if (controller) controller.pinsGroup.visible = mode !== 'paint'
  }, [controller, mode])

  const reloadModel = useCallback(
    async (segmentation?: ARProject['segmentation']) => {
      if (!modelBlobRef.current || !doc) return null
      const format = formatFromFileName(doc.model)!
      const m = await loadModel(modelBlobRef.current, format, segmentation)
      setModel(m)
      return m
    },
    [doc],
  )

  const startPaintOn = (m: LoadedModel, meshName: string | undefined, d: ARProject) => {
    const target =
      (meshName && m.parts.find((p) => p.name === meshName)) ||
      m.parts.reduce((a, b) =>
        (a.mesh.geometry.attributes.position?.count ?? 0) >= (b.mesh.geometry.attributes.position?.count ?? 0) ? a : b,
      )
    const existing = d.segmentation?.[target.name]
    const session = new PaintSession(target.mesh, existing)
    const segments = existing?.segments.length
      ? existing.segments
      : [{ id: 1, name: 'Segment 1', color: LABEL_COLORS[0] }]
    session.repaintAll(segments)
    setPaint({
      meshName: target.name,
      session,
      segments,
      activeId: segments[0].id,
      tool: 'brush',
      radius: 0.08,
      erase: false,
      through: false,
    })
  }

  const enterPaint = async () => {
    if (!doc) return
    const fresh = await reloadModel(undefined) // unsplit
    if (!fresh) return
    startPaintOn(fresh, doc.segmentation && Object.keys(doc.segmentation)[0], doc)
    setMode('paint')
    setSelectedLabelId(undefined)
  }

  const switchPaintMesh = (meshName: string) => {
    if (!model || !doc || !paint) return
    // keep the current mesh's work in the doc? No — switching discards unsaved
    // strokes on the previous mesh (they're still in doc if applied before).
    startPaintOn(model, meshName, doc)
  }

  const applyPaint = async () => {
    if (!paint || !doc) return
    const used = paint.session.usage()
    const segments = paint.segments.filter((s) => (used.get(s.id) ?? 0) > 0)
    const segmentation: ARProject['segmentation'] = { ...(doc.segmentation ?? {}) }
    if (segments.length === 0) {
      delete segmentation[paint.meshName]
    } else {
      segmentation[paint.meshName] = {
        segments,
        faceRuns: facesToRuns(paint.session.faceSeg),
        faceCount: paint.session.faceCount,
      }
    }
    updateDoc({ segmentation })
    setPaint(null)
    setMode('select')
    await reloadModel(segmentation)
  }

  const cancelPaint = async () => {
    setPaint(null)
    setMode('select')
    await reloadModel(doc?.segmentation)
  }

  const onStroke = useCallback(
    (point: import('three').Vector3, dir: import('three').Vector3) => {
      setPaint((p) => {
        if (!p) return p
        p.session.paint(point, p.radius, p.erase ? 0 : p.activeId, p.segments, dir, p.through)
        return p
      })
    },
    [],
  )

  // ---- morph objects (extra models) ----
  const addExtraObject = async (file: File) => {
    if (!doc) return
    const format = formatFromFileName(file.name)
    if (!format) {
      alert('Unsupported format. Use .glb, .gltf, .obj or .stl')
      return
    }
    const key = Math.max(-1, ...(doc.extraModels ?? []).map((m, i) => m.key ?? i)) + 1
    await saveExtraModel(doc.id, key, file)
    const entry = {
      file: `object-${key + 2}.${format}`,
      name: file.name.replace(/\.[^.]+$/, ''),
      key,
    }
    updateDoc((d) => ({ ...d, extraModels: [...(d.extraModels ?? []), entry] }))
  }

  const removeExtraObject = async (index: number) => {
    if (!doc?.extraModels) return
    const m = doc.extraModels[index]
    await deleteExtraModel(doc.id, m.key ?? index)
    updateDoc((d) => ({ ...d, extraModels: d.extraModels!.filter((_, i) => i !== index) }))
  }

  const onLasso = useCallback(
    (polygon: { x: number; y: number }[], camera: import('three').Camera) => {
      setPaint((p) => {
        if (!p) return p
        p.session.lassoPaint(polygon, camera, p.erase ? 0 : p.activeId, p.segments, p.through)
        return { ...p } // re-render so the face counters refresh after a loop
      })
    },
    [],
  )

  const onViewportPick = useCallback(
    (r: PickResult) => {
      if (!doc) return
      if (mode === 'addLabel' && r.point) {
        const n = doc.labels.length
        const label: Label = {
          id: newLabelId(),
          title: `Label ${n + 1}`,
          description: '',
          anchor: r.point,
          meshName: r.meshName, // auto-bind the part that was clicked
          color: LABEL_COLORS[n % LABEL_COLORS.length],
          rank: 0,
        }
        updateDoc((d) => ({ ...d, labels: [...d.labels, label] }))
        setSelectedLabelId(label.id)
        setMode('select')
        return
      }
      if (r.labelId) setSelectedLabelId(r.labelId)
      else if (r.meshName) {
        const bound = doc.labels.find((l) => l.meshName === r.meshName)
        setSelectedLabelId(bound?.id)
      } else setSelectedLabelId(undefined)
    },
    [doc, mode, updateDoc],
  )

  if (error) {
    return (
      <div className="app-shell" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <div className="card" style={{ maxWidth: 460 }}>
          <h3>Cannot open editor</h3>
          <p className="muted">{error}</p>
          <Link to="/"><button>Home</button></Link>
        </div>
      </div>
    )
  }
  if (!doc || !model) {
    return <div className="app-shell" style={{ alignItems: 'center', justifyContent: 'center' }}>Loading…</div>
  }

  const selectedLabel = doc.labels.find((l) => l.id === selectedLabelId)

  return (
    <div className="app-shell">
      <div className="topbar">
        <Link to="/" className="brand" style={{ fontSize: 15 }}>AR Label Studio</Link>
        <input
          value={doc.name}
          onChange={(e) => updateDoc({ name: e.target.value })}
          style={{ fontWeight: 600, width: 260 }}
        />
        <button onClick={() => setTab('labels')} style={tab === 'labels' ? tabActive : undefined}>Model & Labels</button>
        <button onClick={() => setTab('marker')} style={tab === 'marker' ? tabActive : undefined}>Marker & Export</button>
        <span className="spacer" />
        {shareActive && (
          <span className="badge sample" title="A phone-share link is live — manage it in Marker & Export">
            📱 sharing
          </span>
        )}
        <span className="muted small">saved locally</span>
        <Link to={`/preview/${doc.id}`}><button>3D preview</button></Link>
        <Link to={`/view/${doc.id}`}><button>AR view</button></Link>
      </div>

      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div style={{ flex: 1, minWidth: 0, position: 'relative' }}>
          <QuadViewport
            controller={controller}
            transform={doc.transform}
            orientation={doc.cardOrientation ?? 'upright'}
            mode={mode}
            onPick={onViewportPick}
            paint={
              mode === 'paint' && paint
                ? { mesh: paint.session.mesh, radius: paint.radius, tool: paint.tool, onStroke, onLasso }
                : null
            }
          />
        </div>

        <div style={{ width: 360, flex: '0 0 auto', borderLeft: '1px solid var(--border)', background: 'var(--bg-raised)', overflowY: 'auto', padding: 14, display: 'flex', flexDirection: 'column', gap: 14 }}>
          {mode === 'paint' && paint ? (
            <PaintPanel
              paint={paint}
              meshNames={model.parts.map((p) => p.name)}
              onChange={setPaint}
              onSwitchMesh={switchPaintMesh}
              onApply={applyPaint}
              onCancel={cancelPaint}
            />
          ) : tab === 'labels' ? (
            <>
              <button className="primary" onClick={() => setMode(mode === 'addLabel' ? 'select' : 'addLabel')}>
                {mode === 'addLabel' ? 'Cancel placing' : '+ Add label (click model)'}
              </button>
              <button onClick={enterPaint} title="Brush-paint masks that become highlightable parts">
                🖌 Paint segments{doc.segmentation && Object.keys(doc.segmentation).length > 0 ? ' (edit)' : ''}
              </button>

              <section>
                <h3 className="small" style={sectionTitle}>Labels · tour order</h3>
                {doc.labels.length === 0 && <div className="muted small">No labels yet.</div>}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {doc.labels.map((l, i) => (
                    <LabelRow
                      key={l.id}
                      label={l}
                      index={i}
                      total={doc.labels.length}
                      selected={l.id === selectedLabelId}
                      partNames={model.parts.map((p) => p.name)}
                      onSelect={() => setSelectedLabelId(l.id === selectedLabelId ? undefined : l.id)}
                      onChange={(patch) => updateLabel(l.id, patch)}
                      onDelete={() => {
                        updateDoc((d) => ({ ...d, labels: d.labels.filter((x) => x.id !== l.id) }))
                        if (selectedLabelId === l.id) setSelectedLabelId(undefined)
                      }}
                      onMove={(dir) =>
                        updateDoc((d) => {
                          const labels = [...d.labels]
                          const j = i + dir
                          if (j < 0 || j >= labels.length) return d
                          ;[labels[i], labels[j]] = [labels[j], labels[i]]
                          return { ...d, labels }
                        })
                      }
                    />
                  ))}
                </div>
              </section>

              <section>
                <h3 className="small" style={sectionTitle}>Model parts ({model.parts.length})</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 220, overflowY: 'auto' }}>
                  {model.parts.map((p) => {
                    const boundLabels = doc.labels.filter((l) => l.meshName === p.name)
                    return (
                      <div
                        key={p.name}
                        onMouseEnter={() => setHoverPart(p.name)}
                        onMouseLeave={() => setHoverPart(undefined)}
                        style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 6, background: hoverPart === p.name ? 'var(--bg-panel)' : 'transparent' }}
                      >
                        <span className="small" style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{p.name}</span>
                        {boundLabels.map((l) => (
                          <span key={l.id} title={l.title} style={{ width: 10, height: 10, borderRadius: 999, background: l.color, flex: '0 0 auto' }} />
                        ))}
                        {selectedLabel && selectedLabel.meshName !== p.name && (
                          <button className="small" style={{ padding: '2px 8px' }} onClick={() => updateLabel(selectedLabel.id, { meshName: p.name })}>
                            bind
                          </button>
                        )}
                      </div>
                    )
                  })}
                </div>
              </section>

              <section>
                <h3 className="small" style={sectionTitle}>Objects · morph sequence</h3>
                <div className="small" style={{ padding: '4px 8px' }}>
                  1. {doc.name} <span className="muted">(this model, with the labels)</span>
                </div>
                {(doc.extraModels ?? []).map((m, i) => (
                  <div key={m.key ?? i} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 8px' }}>
                    <span className="small muted">{i + 2}.</span>
                    <input
                      value={m.name}
                      onChange={(e) =>
                        updateDoc((d) => ({
                          ...d,
                          extraModels: d.extraModels!.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)),
                        }))
                      }
                      style={{ flex: 1, minWidth: 0 }}
                    />
                    <button className="danger small" style={{ padding: '2px 8px' }} onClick={() => removeExtraObject(i)}>
                      ✕
                    </button>
                  </div>
                ))}
                <label className="small" style={{ display: 'inline-block', marginTop: 6 }}>
                  <span
                    role="button"
                    style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '5px 12px', cursor: 'pointer' }}
                  >
                    + add object (morph target)
                  </span>
                  <input
                    type="file"
                    accept=".glb,.gltf,.obj,.stl"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      if (e.target.files?.[0]) addExtraObject(e.target.files[0])
                      e.target.value = ''
                    }}
                  />
                </label>
                <p className="small muted" style={{ margin: '6px 0 0' }}>
                  In the viewer, a ⇄ button morphs object 1 → 2 → 3 … (labels belong to object 1).
                </p>
              </section>

              <section>
                <h3 className="small" style={sectionTitle}>Placement on the card</h3>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginBottom: 8 }}>
                  <label className="small">
                    <input
                      type="radio"
                      checked={(doc.cardOrientation ?? 'upright') === 'upright'}
                      onChange={() => updateDoc((d) => ({ ...d, cardOrientation: 'upright', transform: { ...d.transform, offset: [...DEFAULT_TRANSFORM.offset] } }))}
                    />{' '}
                    Card upright — on a screen, wall, or held up (model faces the viewer)
                  </label>
                  <label className="small">
                    <input
                      type="radio"
                      checked={doc.cardOrientation === 'flat'}
                      onChange={() => updateDoc((d) => ({ ...d, cardOrientation: 'flat', transform: { ...d.transform, offset: [...FLAT_TRANSFORM.offset] } }))}
                    />{' '}
                    Card flat on a table (model stands on the card)
                  </label>
                </div>
                <SliderRow label={`Scale ${doc.transform.scale.toFixed(2)}×`} min={0.2} max={3} step={0.05} value={doc.transform.scale}
                  onChange={(v) => updateDoc((d) => ({ ...d, transform: { ...d.transform, scale: v } }))} />
                <div className="small muted" style={{ margin: '6px 0 2px' }}>Move (relative to the card)</div>
                {(['X — left / right', 'Y — down / up', 'Z — back / forward'] as const).map((axisLabel, axis) => (
                  <SliderRow
                    key={`mv${axis}`}
                    label={`${axisLabel.slice(0, 1)} ${doc.transform.offset[axis].toFixed(2)}`}
                    title={axisLabel}
                    min={-1}
                    max={1.5}
                    step={0.05}
                    value={doc.transform.offset[axis]}
                    onChange={(v) =>
                      updateDoc((d) => {
                        const offset = [...d.transform.offset] as [number, number, number]
                        offset[axis] = v
                        return { ...d, transform: { ...d.transform, offset } }
                      })
                    }
                  />
                ))}
                <div className="small muted" style={{ margin: '6px 0 2px' }}>Rotate (degrees)</div>
                {(['X — tilt forward/back', 'Y — turn left/right', 'Z — roll'] as const).map((axisLabel, axis) => (
                  <SliderRow
                    key={`rot${axis}`}
                    label={`${axisLabel.slice(0, 1)} ${(doc.transform.rotation[axis] * 57.2958).toFixed(0)}°`}
                    title={axisLabel}
                    min={-Math.PI}
                    max={Math.PI}
                    step={Math.PI / 36}
                    value={doc.transform.rotation[axis]}
                    onChange={(v) =>
                      updateDoc((d) => {
                        const rotation = [...d.transform.rotation] as [number, number, number]
                        rotation[axis] = v
                        return { ...d, transform: { ...d.transform, rotation } }
                      })
                    }
                  />
                ))}
                <button
                  className="small"
                  style={{ marginTop: 4 }}
                  onClick={() =>
                    updateDoc((d) => ({
                      ...d,
                      transform: {
                        scale: 1,
                        rotation: [0, 0, 0],
                        offset: [...(d.cardOrientation === 'flat' ? FLAT_TRANSFORM : DEFAULT_TRANSFORM).offset] as [number, number, number],
                      },
                    }))
                  }
                >
                  reset placement
                </button>
                <p className="small muted" style={{ margin: '6px 0 0' }}>
                  The blue outline in the viewport is the printed card — move and rotate the model
                  relative to it.
                </p>
              </section>

              <section>
                <h3 className="small" style={sectionTitle}>Behavior</h3>
                {model.animations.length > 0 && (
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                    <span className="small muted">Animation</span>
                    <select
                      value={doc.animation?.clip ?? model.animations[0].name}
                      onChange={(e) => updateDoc((d) => ({ ...d, animation: { ...d.animation, clip: e.target.value, autoplay: d.animation?.autoplay ?? true } }))}
                    >
                      {model.animations.map((c) => <option key={c.name}>{c.name}</option>)}
                    </select>
                    <label className="small">
                      <input
                        type="checkbox"
                        checked={doc.animation?.autoplay ?? true}
                        onChange={(e) => updateDoc((d) => ({ ...d, animation: { ...d.animation, autoplay: e.target.checked } }))}
                      /> autoplay
                    </label>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
                  <span className="small muted">Intro animation</span>
                  <select
                    value={doc.introStyle ?? 'assemble'}
                    onChange={(e) => updateDoc({ introStyle: e.target.value as ARProject['introStyle'] })}
                    style={{ flex: 1, minWidth: 0 }}
                    title={INTRO_STYLES.find((s) => s.id === (doc.introStyle ?? 'assemble'))?.description}
                  >
                    {INTRO_STYLES.map((s) => (
                      <option key={s.id} value={s.id} title={s.description}>{s.label} — {s.description}</option>
                    ))}
                  </select>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span className="small muted">Tour auto-advance</span>
                  <select
                    value={doc.tourAutoSec ?? 0}
                    onChange={(e) => updateDoc({ tourAutoSec: Number(e.target.value) })}
                  >
                    <option value={0}>manual (tap)</option>
                    <option value={5}>5 s</option>
                    <option value={8}>8 s</option>
                    <option value={12}>12 s</option>
                  </select>
                </div>
                <p className="small muted" style={{ margin: '6px 0 0' }}>
                  Preview the intro from the 3D preview page (↻ Intro button).
                </p>
              </section>
            </>
          ) : (
            <MarkerPanel doc={doc} updateDoc={updateDoc} partNames={model.parts.map((p) => p.name)} />
          )}
        </div>
      </div>
    </div>
  )
}

function LabelRow({
  label, index, total, selected, partNames, onSelect, onChange, onDelete, onMove,
}: {
  label: Label
  index: number
  total: number
  selected: boolean
  partNames: string[]
  onSelect: () => void
  onChange: (patch: Partial<Label>) => void
  onDelete: () => void
  onMove: (dir: -1 | 1) => void
}) {
  return (
    <div className="card" style={{ padding: 10, borderColor: selected ? label.color : 'var(--border)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          onClick={onSelect}
          style={{ background: label.color, color: '#0b0e13', borderRadius: 999, width: 22, height: 22, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 12, cursor: 'pointer', flex: '0 0 auto' }}
        >
          {index + 1}
        </span>
        <input value={label.title} onChange={(e) => onChange({ title: e.target.value })} style={{ flex: 1, minWidth: 0 }} />
        <button className="small" style={{ padding: '2px 7px' }} disabled={index === 0} onClick={() => onMove(-1)}>↑</button>
        <button className="small" style={{ padding: '2px 7px' }} disabled={index === total - 1} onClick={() => onMove(1)}>↓</button>
      </div>
      {selected && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 }}>
          <textarea
            placeholder="Description (shown when tapped / during the tour)"
            value={label.description}
            rows={3}
            onChange={(e) => onChange({ description: e.target.value })}
          />
          <div style={{ display: 'flex', gap: 5, alignItems: 'center' }}>
            {LABEL_COLORS.map((c) => (
              <span
                key={c}
                onClick={() => onChange({ color: c })}
                style={{ width: 18, height: 18, borderRadius: 999, background: c, cursor: 'pointer', border: label.color === c ? '2px solid #fff' : '2px solid transparent' }}
              />
            ))}
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="small muted">Part</span>
            <select value={label.meshName ?? ''} onChange={(e) => onChange({ meshName: e.target.value || undefined })} style={{ flex: 1, minWidth: 0 }}>
              <option value="">(none)</option>
              {partNames.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <span className="small muted" title="When walking closer reveals this label">Visible from</span>
            <select value={label.rank} onChange={(e) => onChange({ rank: Number(e.target.value) })}>
              <option value={0}>always</option>
              <option value={1}>far</option>
              <option value={2}>medium</option>
              <option value={3}>near</option>
              <option value={4}>very close</option>
            </select>
            <span className="spacer" style={{ flex: 1 }} />
            <button className="danger small" onClick={onDelete}>delete</button>
          </div>
        </div>
      )}
    </div>
  )
}

function SliderRow({ label, title, min, max, step, value, onChange }: { label: string; title?: string; min: number; max: number; step: number; value: number; onChange: (v: number) => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }} title={title}>
      <span className="small muted" style={{ width: 90, flex: '0 0 auto' }}>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} style={{ flex: 1 }} />
    </div>
  )
}

const sectionTitle: React.CSSProperties = { textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-dim)', marginBottom: 8 }
const tabActive: React.CSSProperties = { borderColor: 'var(--accent)', color: 'var(--accent)' }
