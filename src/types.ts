/** A label pinned to the model surface. */
export interface Label {
  id: string
  title: string
  description: string
  /** Anchor point in normalized model space (model centered at origin, max dimension = 1). */
  anchor: [number, number, number]
  /** Optional mesh/node name this label is bound to, for part highlighting. */
  meshName?: string
  color: string
  /** Importance rank for camera-distance LOD: 0 = always visible, higher = only when closer. */
  rank: number
}

/** Entrance animation styles for the model when the marker is found. */
export type IntroStyle = 'assemble' | 'burst' | 'fade' | 'cascade' | 'spiral' | 'connections'

export const INTRO_STYLES: { id: IntroStyle; label: string; description: string }[] = [
  { id: 'assemble', label: 'Assemble', description: 'Parts fly together from an exploded state' },
  { id: 'burst', label: 'Burst', description: 'Explodes outward from the center, then settles' },
  { id: 'fade', label: 'Fade & rise', description: 'Parts fade in one after another, rising softly' },
  { id: 'cascade', label: 'Cascade', description: 'Parts drop in from above in sequence' },
  { id: 'spiral', label: 'Spiral', description: 'Parts swirl in around the model axis' },
  { id: 'connections', label: 'Connections', description: 'Parts fade in linked by glowing lines' },
]

/** A painted segment ("virtual part") of a single mesh. */
export interface SegmentDef {
  id: number
  name: string
  color: string
}

/**
 * Brush-painted face mask for one mesh. Faces are numbered in the mesh's
 * non-indexed triangle order (face i = vertices 3i..3i+2), which is stable
 * for a given model file + three version. At load time the mesh is split into
 * one real mesh per segment, so segments behave exactly like separate parts
 * (highlight, isolate, explode, label binding, multi-card).
 */
export interface MeshSegmentation {
  segments: SegmentDef[]
  /** RLE pairs [segmentId, runLength] over faces; segment 0 = unassigned. */
  faceRuns: [number, number][]
  faceCount: number
}

/** One compiled image target inside targets.mind. */
export interface TargetDef {
  index: number
  /** main = single flat card; face = one face of a fold-up tent; card = separate card in a multi-card scene. */
  role: 'main' | 'face' | 'card'
  /** For role 'card': mesh names rendered by this card. Empty/absent = whole model. */
  meshNames?: string[]
}

/** Placement of the model relative to the marker card. */
export interface ModelTransform {
  scale: number
  /** Euler XYZ, radians. */
  rotation: [number, number, number]
  offset: [number, number, number]
}

export type ModelFormat = 'glb' | 'gltf' | 'obj' | 'stl'

/** The serializable project document (project.json in an exported bundle). */
export interface ARProject {
  id: string
  name: string
  /** Model filename inside the bundle, e.g. "model.glb". */
  model: string
  transform: ModelTransform
  labels: Label[]
  targets: TargetDef[]
  animation?: { clip?: string; autoplay: boolean }
  /** Auto-advance interval for tour mode, seconds. 0/undefined = manual. */
  tourAutoSec?: number
  /** Marker style: single flat card or 3-face fold-up tent. */
  markerStyle: 'single' | 'tent'
  /**
   * How the printed card is expected to be held: 'upright' (on a screen, wall
   * or held up — model faces the viewer) or 'flat' (lying on a table — model
   * stands up out of the card). Default 'upright'.
   */
  cardOrientation?: 'flat' | 'upright'
  /** Brush-painted masks per mesh name — split into real parts at load time. */
  segmentation?: Record<string, MeshSegmentation>
  /** Entrance animation played when the marker is found. Default 'assemble'. */
  introStyle?: IntroStyle
  /**
   * Additional objects for a morph sequence: in the viewer, the model morphs
   * 1 → 2 → 3 … on tap. `file` is the filename inside the bundle; `key` is the
   * stable local-storage slot (survives removals, defaults to index).
   */
  extraModels?: { file: string; name: string; key?: number }[]
  attribution?: string
  createdAt: number
  updatedAt: number
}

/** Default placement for an upright card: centered, floating slightly in front. */
export const DEFAULT_TRANSFORM: ModelTransform = {
  scale: 1,
  rotation: [0, 0, 0],
  offset: [0, 0, 0.15],
}

/** Default placement for a card lying flat on a table: standing on the card. */
export const FLAT_TRANSFORM: ModelTransform = {
  scale: 1,
  rotation: [0, 0, 0],
  offset: [0, 0.55, 0],
}

export const LABEL_COLORS = [
  '#ff5c7a',
  '#ffb04c',
  '#ffe14c',
  '#6ee86e',
  '#4cc9ff',
  '#9d7bff',
  '#ff7bd5',
  '#7bffd4',
]

export function newProjectId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function newLabelId(): string {
  return `l-${Math.random().toString(36).slice(2, 10)}`
}
