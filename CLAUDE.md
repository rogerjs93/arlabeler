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

## Verify

`npx tsc -b` + `npm run build`. In a real browser: create project, place labels in
the ortho views, generate marker + compile, preview effects. Live AR tracking needs
a physical phone + printed card (Roger does that final test).
