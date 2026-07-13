# AR Label Studio — project notes

Pipeline: label a 3D model in a desktop editor → generate a printable QR marker
card → view in AR on any phone (browser only, nothing to install). For
presentations/education; ships preloaded, editable anatomical samples.

## Stack / constraints

- Vite 6 + React 19 + TS, **hash routing**, `base: './'` (GitHub Pages under a
  subpath). No backend; projects live in IndexedDB (`src/store/projects.ts`) and
  export as static bundles under `public/projects/<id>/`.
- **three pinned to 0.161** (mind-ar's prod dist uses `sRGBEncoding`, removed in
  later three). Don't bump three without checking mind-ar compatibility.
- Node here is v20.15 — Vite 7 needs 20.19+, hence Vite 6. Don't `npm create vite`
  onto latest without pinning.

## mind-ar gotchas (hard-won)

- **Viewer** (`src/pages/ARView.tsx`) imports `MindARThree` from the prebuilt
  `mind-ar/dist/mindar-image-three.prod.js` — the standard, tested runtime path.
- **Compiler** (`src/marker/compileMind.ts`) must NOT use the prod-dist `Compiler`
  (its inlined worker never posts back when re-bundled → hangs) and must NOT import
  `mind-ar/src/.../compiler.js` (its `?worker&inline` import breaks esbuild
  pre-bundling). Instead we subclass `CompilerBase` and run track-compilation on
  the main thread, AND we import `mind-ar/src/.../detector/kernels/index.js` to
  register the custom tfjs kernels — without it `Detector.detect()` hangs forever.
- The compiler awaits `tf.nextFrame()` (= `requestAnimationFrame`). It only runs in
  a real, visible browser tab. **Headless/background automation has no rAF**, so
  the in-browser compile can't be verified there — use `scripts/makeSampleMarker.mjs`
  (Node + node-canvas + mind-ar `OfflineCompiler`) instead. Node timers make
  `nextFrame` resolve, so Node compile works and is verified.

## Model space convention

`loadModel` normalizes every model to centered-at-origin, max-dimension = 1. Label
anchors are stored in this normalized space so they're unit-independent. The card
is 1 world unit wide in the AR viewer; `ModelTransform.offset` is Y-up (converted
to the card's Z-out in ARView).

## Shared 3D layer

`EffectsController` (`src/scene/effects.ts`) is plain three.js, driven by
`update(dt, camera)` from whatever loop hosts it (R3F in preview/editor,
`renderer.setAnimationLoop` in AR). It owns entrance/idle, explode, isolate/X-ray,
highlight, camera-distance label LOD, proximity focus, clips, and tour dimming.
Pins are billboard sprites (`src/scene/pins.ts`). Editor uses a 4-viewport
scissored canvas (`QuadViewport.tsx`).

## Brush segmentation

Whole/single-mesh models can be brush-painted into "virtual parts"
(`src/scene/segmentation.ts` + editor paint mode). Masks are per-face over the
mesh's **non-indexed** triangle order, stored RLE in `project.json`
(`segmentation` field), and baked into real separate meshes by `loadModel` — so
segments behave like separate models everywhere (highlight, isolate, explode,
labels, multi-card). Painting always operates on the unsplit mesh: entering
paint mode reloads without segmentation; apply/cancel reload with it. Logic has
a Node test pattern (esbuild-bundle `segmentation.ts` with `--external:three`,
run against a SphereGeometry — see git history of the verify flow).

## Direct share (no backend, no storage)

"Share to phone" (`src/share/tempShare.ts`) streams the project desktop→phone
over WebRTC (PeerJS + its free public signaling cloud). QR opens
`#/view/shared?peer=<id>`; the editor tab must stay open while phones load.
Verified loopback through the real PeerJS cloud (byte-exact model transfer).
Do NOT go back to free file hosts for this: tmpfiles.org uploads fine from the
browser but its /dl/ endpoint sends **no CORS headers**, so the phone can never
read the file (this bug shipped once — heading said "Project not found").
The `?src=<zip url>` loader still exists for any CORS-accessible hosted bundle
(also accepts folder-wrapped publish zips). Caveat: no TURN server configured,
so peers on mutually restrictive NATs may fail — same-WiFi is the target case.

## Headless verification (embedded browser pane)

The automation pane's document is `hidden`: native rAF **never fires** and
ResizeObserver **never delivers** (both are "before paint"). Two shims make the
app fully verifiable there anyway:
- `index.html` races native rAF vs a setTimeout (32 ms visible / 250 ms hidden);
- `src/utils/pollingResizeObserver.ts` is passed as r3f `<Canvas resize>`
  polyfill only when `document.hidden` at load.
With both, the editor mounts for real: drive it with synthetic PointerEvents on
the canvas and assert via DOM text / `window.__ar` (Preview's dev hook).
Also: raycasting after moving a camera needs `cam.updateMatrixWorld()` — render
loops normally hide this, headless exposed it.

## Verify

`npx tsc -b` + `npm run build`. In a real browser: create project, place labels in
the ortho views, generate marker + compile, preview effects. Live AR tracking needs
a physical phone + printed card (Roger does that final test).
