/** Build stamp injected by vite.config.ts `define`. */
declare const __BUILD__: string

declare module 'mind-ar/dist/mindar-image-three.prod.js' {
  import type { Scene, WebGLRenderer, PerspectiveCamera, Group } from 'three'

  export interface MindARAnchor {
    group: Group
    targetIndex: number
    visible: boolean
    onTargetFound?: () => void
    onTargetLost?: () => void
  }

  export class MindARThree {
    constructor(options: {
      container: HTMLElement
      imageTargetSrc: string
      maxTrack?: number
      uiLoading?: string
      uiScanning?: string
      uiError?: string
      filterMinCF?: number
      filterBeta?: number
      warmupTolerance?: number
      missTolerance?: number
    })
    renderer: WebGLRenderer
    scene: Scene
    camera: PerspectiveCamera
    addAnchor(targetIndex: number): MindARAnchor
    start(): Promise<void>
    stop(): void
  }
}

// We compile from the src entry (see compileMind.ts) so Vite bundles tfjs and
// the custom kernels correctly. These declarations type just what we use.
declare module 'mind-ar/src/image-target/detector/kernels/index.js' {
  // side-effect import: registers custom tfjs kernels
}

declare module 'mind-ar/src/image-target/compiler-base.js' {
  export class CompilerBase {
    compileImageTargets(
      images: HTMLImageElement[],
      progressCallback: (progress: number) => void,
    ): Promise<unknown[]>
    exportData(): ArrayBuffer | Uint8Array
    createProcessCanvas(img: { width: number; height: number }): HTMLCanvasElement
    compileTrack(args: {
      progressCallback: (percent: number) => void
      targetImages: { data: Uint8Array; width: number; height: number }[]
      basePercent: number
    }): Promise<unknown[]>
  }
}

declare module 'mind-ar/src/image-target/tracker/extract-utils.js' {
  export function extractTrackingFeatures(
    imageList: unknown[],
    doneCallback: (index: number) => void,
  ): unknown
}

declare module 'mind-ar/src/image-target/image-list.js' {
  export function buildTrackingImageList(targetImage: {
    data: Uint8Array
    width: number
    height: number
  }): unknown[]
  export function buildImageList(targetImage: {
    data: Uint8Array
    width: number
    height: number
  }): unknown[]
}
