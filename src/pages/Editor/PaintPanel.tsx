import type { SegmentDef } from '../../types'
import { LABEL_COLORS } from '../../types'
import type { PaintSession } from '../../scene/segmentation'

export interface PaintState {
  meshName: string
  session: PaintSession
  segments: SegmentDef[]
  activeId: number
  radius: number
  erase: boolean
  through: boolean
}

/**
 * Sidebar UI for brush segmentation: manage segments (name/color), brush
 * settings, and apply/cancel. The actual painting happens in QuadViewport
 * strokes; Editor owns the PaintState.
 */
export default function PaintPanel({
  paint,
  meshNames,
  onChange,
  onSwitchMesh,
  onApply,
  onCancel,
}: {
  paint: PaintState
  meshNames: string[]
  onChange: (next: PaintState) => void
  onSwitchMesh: (meshName: string) => void
  onApply: () => void
  onCancel: () => void
}) {
  const { session, segments, activeId } = paint
  const usage = session.usage()

  const addSegment = () => {
    const id = Math.max(0, ...segments.map((s) => s.id)) + 1
    const seg: SegmentDef = {
      id,
      name: `Segment ${id}`,
      color: LABEL_COLORS[(id - 1) % LABEL_COLORS.length],
    }
    onChange({ ...paint, segments: [...segments, seg], activeId: id, erase: false })
  }

  const updateSegment = (id: number, patch: Partial<SegmentDef>) => {
    const next = segments.map((s) => (s.id === id ? { ...s, ...patch } : s))
    if (patch.color) session.repaintAll(next)
    onChange({ ...paint, segments: next })
  }

  const deleteSegment = (id: number) => {
    const next = segments.filter((s) => s.id !== id)
    session.clearSegment(id, next)
    onChange({ ...paint, segments: next, activeId: next[0]?.id ?? 0 })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="card" style={{ padding: 10, borderColor: 'var(--accent)' }}>
        <strong className="small">Paint segments</strong>
        <p className="small muted" style={{ margin: '6px 0 0' }}>
          Drag on the model to paint a mask. On apply, each mask becomes a real part —
          labels can bind to it, and it highlights, isolates and explodes on its own.
        </p>
      </div>

      {meshNames.length > 1 && (
        <section>
          <h3 className="small" style={sectionTitle}>Mesh to paint</h3>
          <select value={paint.meshName} onChange={(e) => onSwitchMesh(e.target.value)} style={{ width: '100%' }}>
            {meshNames.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </section>
      )}

      <section>
        <h3 className="small" style={sectionTitle}>Segments</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {segments.map((s) => (
            <div
              key={s.id}
              className="card"
              style={{
                padding: 8,
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                borderColor: !paint.erase && s.id === activeId ? s.color : 'var(--border)',
                cursor: 'pointer',
              }}
              onClick={() => onChange({ ...paint, activeId: s.id, erase: false })}
            >
              <input
                type="color"
                value={s.color}
                onChange={(e) => updateSegment(s.id, { color: e.target.value })}
                onClick={(e) => e.stopPropagation()}
                style={{ width: 26, height: 26, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
              />
              <input
                value={s.name}
                onChange={(e) => updateSegment(s.id, { name: e.target.value })}
                onClick={(e) => e.stopPropagation()}
                style={{ flex: 1, minWidth: 0 }}
              />
              <span className="small muted" title="painted faces">{usage.get(s.id) ?? 0}</span>
              <button
                className="danger small"
                style={{ padding: '2px 8px' }}
                onClick={(e) => {
                  e.stopPropagation()
                  deleteSegment(s.id)
                }}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
        <button className="small" style={{ marginTop: 6 }} onClick={addSegment}>+ add segment</button>
      </section>

      <section>
        <h3 className="small" style={sectionTitle}>Brush</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span className="small muted" style={{ width: 70 }}>Size {paint.radius.toFixed(2)}</span>
          <input
            type="range"
            min={0.01}
            max={0.3}
            step={0.01}
            value={paint.radius}
            onChange={(e) => onChange({ ...paint, radius: Number(e.target.value) })}
            style={{ flex: 1 }}
          />
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <label className="small">
            <input
              type="checkbox"
              checked={paint.erase}
              onChange={(e) => onChange({ ...paint, erase: e.target.checked })}
            />{' '}
            eraser
          </label>
          <label className="small" title="Also paint faces on the far side of the model">
            <input
              type="checkbox"
              checked={paint.through}
              onChange={(e) => onChange({ ...paint, through: e.target.checked })}
            />{' '}
            paint through
          </label>
        </div>
      </section>

      <div style={{ display: 'flex', gap: 8 }}>
        <button className="primary" style={{ flex: 1 }} onClick={onApply}>Apply segmentation</button>
        <button onClick={onCancel}>Cancel</button>
      </div>
      <p className="small muted" style={{ margin: 0 }}>
        Unpainted surface stays as “{paint.meshName}_rest”.
      </p>
    </div>
  )
}

const sectionTitle: React.CSSProperties = { textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text-dim)', marginBottom: 8 }
