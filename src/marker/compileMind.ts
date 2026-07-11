// Compile card images into a .mind target file, fully in the browser.
//
// We deliberately avoid mind-ar's prebuilt dist Compiler (its inlined compile
// worker does not post back when re-bundled by another Vite app, hanging the
// promise) AND its src `compiler.js` (which imports the worker via `?worker`, a
// suffix esbuild can't pre-bundle from inside node_modules). Instead we subclass
// CompilerBase and run the track-compilation step on the main thread using the
// same pure-JS routine the worker uses. Compilation is CPU-heavy (~tens of
// seconds); callers should show progress and keep it off the critical path.
// Registers mind-ar's custom tfjs kernels (webgl + cpu). Without this the
// detector's custom ops have no kernel and Detector.detect() hangs forever.
import 'mind-ar/src/image-target/detector/kernels/index.js'
import { CompilerBase } from 'mind-ar/src/image-target/compiler-base.js'
import { extractTrackingFeatures } from 'mind-ar/src/image-target/tracker/extract-utils.js'
import { buildTrackingImageList } from 'mind-ar/src/image-target/image-list.js'

interface TargetImage {
  data: Uint8Array
  width: number
  height: number
}

class MainThreadCompiler extends CompilerBase {
  createProcessCanvas(img: { width: number; height: number }): HTMLCanvasElement {
    const c = document.createElement('canvas')
    c.width = img.width
    c.height = img.height
    return c
  }

  // Same work as mind-ar's compile worker, run inline (no Web Worker).
  async compileTrack({
    progressCallback,
    targetImages,
    basePercent,
  }: {
    progressCallback: (percent: number) => void
    targetImages: TargetImage[]
    basePercent: number
  }): Promise<unknown[]> {
    const percentPerImage = 100.0 / targetImages.length
    let percent = 0.0
    const list: unknown[] = []
    for (const targetImage of targetImages) {
      const imageList = buildTrackingImageList(targetImage)
      const percentPerAction = percentPerImage / imageList.length
      const trackingData = extractTrackingFeatures(imageList, () => {
        percent += percentPerAction
        progressCallback(basePercent + (percent * basePercent) / 100)
      })
      list.push(trackingData)
      // yield so the progress UI can paint between images
      await new Promise((r) => setTimeout(r, 0))
    }
    return list
  }
}

export async function compileMindFile(
  targets: HTMLCanvasElement[],
  onProgress?: (percent: number) => void,
): Promise<Blob> {
  const images = await Promise.all(targets.map(canvasToImage))
  const compiler = new MainThreadCompiler()
  await compiler.compileImageTargets(images, (p: number) => onProgress?.(p))
  const buffer = compiler.exportData()
  return new Blob([buffer], { type: 'application/octet-stream' })
}

function canvasToImage(canvas: HTMLCanvasElement): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = reject
    img.src = canvas.toDataURL('image/png')
  })
}
