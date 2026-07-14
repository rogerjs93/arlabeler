import { useEffect, useRef, useState } from 'react'
import type { ARProject, Label } from '../types'
import type { EffectsController } from '../scene/effects'

/**
 * Control overlay + label detail sheet + tour driver, shared by the non-AR
 * preview and the AR viewer. Mutates the EffectsController directly; local
 * state only mirrors what the UI needs to render.
 */
export default function ViewerHud({
  doc,
  controller,
  selectedLabelId,
  onSelectLabel,
  morph,
  children,
}: {
  doc: ARProject
  controller: EffectsController | null
  selectedLabelId?: string
  onSelectLabel: (id?: string) => void
  /** Morph sequence controls (shown when the project has extra objects). */
  morph?: { names: string[]; active: number; busy: boolean; onNext: () => void }
  children?: React.ReactNode
}) {
  const [explode, setExplode] = useState(0)
  const [xray, setXray] = useState(false)
  const [turntable, setTurntable] = useState(false)
  const [tourIdx, setTourIdx] = useState<number | null>(null)
  const [clipPaused, setClipPaused] = useState(false)
  const timerRef = useRef<number | undefined>(undefined)

  const labels = doc.labels
  const tourLabel: Label | undefined = tourIdx !== null ? labels[tourIdx] : undefined
  const selectedLabel = tourLabel ?? labels.find((l) => l.id === selectedLabelId)

  useEffect(() => {
    if (!controller) return
    controller.explode = explode
    controller.xray = xray
    controller.turntable = turntable
    controller.clipPaused = clipPaused
  }, [controller, explode, xray, turntable, clipPaused])

  useEffect(() => {
    if (!controller) return
    controller.setTourLabel(tourLabel?.id)
    if (!tourLabel) controller.setHighlight(labels.find((l) => l.id === selectedLabelId)?.meshName)
  }, [controller, tourLabel, selectedLabelId, labels])

  // auto-advance tour
  useEffect(() => {
    window.clearInterval(timerRef.current)
    if (tourIdx !== null && doc.tourAutoSec && doc.tourAutoSec > 0) {
      timerRef.current = window.setInterval(() => {
        setTourIdx((i) => (i === null ? null : (i + 1) % labels.length))
      }, doc.tourAutoSec * 1000)
    }
    return () => window.clearInterval(timerRef.current)
  }, [tourIdx, doc.tourAutoSec, labels.length])

  const startTour = () => {
    onSelectLabel(undefined)
    setTourIdx(0)
  }
  const stopTour = () => setTourIdx(null)
  const nextTour = () => setTourIdx((i) => (i === null ? 0 : (i + 1) % labels.length))
  const prevTour = () => setTourIdx((i) => (i === null ? 0 : (i - 1 + labels.length) % labels.length))

  const hasClips = (controller?.model.animations.length ?? 0) > 0

  return (
    <>
      {/* top-right toggles */}
      <div style={{ position: 'absolute', top: 12, right: 12, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'flex-end', zIndex: 10 }}>
        <button onClick={() => setXray(!xray)} style={xray ? activeBtn : undefined}>X-ray</button>
        <button onClick={() => setTurntable(!turntable)} style={turntable ? activeBtn : undefined}>Spin</button>
        {hasClips && (
          <button onClick={() => setClipPaused(!clipPaused)}>{clipPaused ? '▶ Anim' : '⏸ Anim'}</button>
        )}
        <button onClick={() => controller?.playEntrance()} title="Replay the intro animation">↻ Intro</button>
        {morph && morph.names.length > 1 && (
          <button
            onClick={morph.onNext}
            disabled={morph.busy}
            title={`Morph into the next object (${morph.active + 1}/${morph.names.length})`}
            style={{ borderColor: 'var(--accent-2)' }}
          >
            ⇄ {morph.names[(morph.active + 1) % morph.names.length]}
          </button>
        )}
        {controller?.isolatedMesh && (
          <button onClick={() => controller.setIsolated(undefined)} style={activeBtn}>Un-isolate</button>
        )}
        {children}
      </div>

      {/* bottom bar: explode + tour */}
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8, zIndex: 10, pointerEvents: 'none' }}>
        {selectedLabel && (
          <div
            style={{
              pointerEvents: 'auto',
              background: 'rgba(14,17,22,0.92)',
              border: `1px solid ${selectedLabel.color}`,
              borderRadius: 12,
              padding: '12px 16px',
              maxWidth: 560,
              margin: '0 auto',
              width: '100%',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ background: selectedLabel.color, color: '#0b0e13', borderRadius: 999, width: 26, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, flex: '0 0 auto' }}>
                {labels.indexOf(selectedLabel) + 1}
              </span>
              <strong style={{ flex: 1 }}>{selectedLabel.title}</strong>
              {tourIdx === null && (
                <button className="small" onClick={() => onSelectLabel(undefined)}>✕</button>
              )}
            </div>
            {selectedLabel.description && (
              <p className="small" style={{ margin: '8px 0 0', color: 'var(--text-dim)', whiteSpace: 'pre-wrap' }}>
                {selectedLabel.description}
              </p>
            )}
          </div>
        )}

        <div style={{ pointerEvents: 'auto', display: 'flex', gap: 10, alignItems: 'center', background: 'rgba(14,17,22,0.85)', border: '1px solid var(--border)', borderRadius: 12, padding: '8px 14px', margin: '0 auto', maxWidth: 560, width: '100%' }}>
          {labels.length > 0 && (
            tourIdx === null ? (
              <button className="primary" onClick={startTour}>▶ Tour</button>
            ) : (
              <>
                <button onClick={prevTour}>‹</button>
                <span className="small muted" style={{ minWidth: 44, textAlign: 'center' }}>
                  {tourIdx + 1}/{labels.length}
                </span>
                <button onClick={nextTour}>›</button>
                <button onClick={stopTour}>Stop</button>
              </>
            )
          )}
          <span className="small muted" style={{ flex: '0 0 auto' }}>Explode</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={explode}
            onChange={(e) => setExplode(Number(e.target.value))}
            style={{ flex: 1, minWidth: 60 }}
          />
        </div>
      </div>
    </>
  )
}

const activeBtn: React.CSSProperties = { borderColor: 'var(--accent)', color: 'var(--accent)' }
