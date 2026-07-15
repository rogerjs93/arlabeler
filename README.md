# AR Label Studio

Label 3D models in a desktop editor, generate a **printable marker card** whose
QR code opens an AR viewer on any phone, and see the model floating over the card
with tappable, part-highlighting labels — browser only, nothing to install.

Built on [mind-ar-js](https://github.com/hiukim/mind-ar-js) (image tracking) and
three.js. Static SPA — deploys to GitHub Pages.

## How it works

1. **New project** from a 3D model (`.glb`, `.gltf`, `.obj`, `.stl`), or open a
   built-in **sample** (starts you with a labeled model).
2. **Editor** — four synchronized views (perspective + Front/Side/Top). Click the
   model to drop a numbered label; edit its title/description/color, bind it to a
   mesh part, and set how close you must be for it to appear. Adjust how the model
   sits on the card.
3. **Marker & Export** — pick a card style (single flat card, fold-up tent, or
   multi-card scene), generate the printable card (a QR code + a feature-rich
   pattern MindAR can track), and compile the `.mind` tracking file in the browser.
   Download the print PNG and the publishable bundle.
4. **Print & view** — print the card, scan its QR with a phone's normal camera; the
   browser opens the AR viewer, point at the card, and the labeled model appears.

### Segmenting whole models

Single-mesh models (scans, STL) can be split into "virtual parts" in the editor's
**Paint segments** mode: a **brush** (radius painting along the surface) and a
**loop** tool (trace around a region — everything inside is selected, more
precise). Masks bake into real parts, so they highlight, isolate, explode and
bind to labels like native parts.

### Getting a project onto a phone

Projects are stored in the browser (IndexedDB) — other devices can't see them.
Two ways to view on a phone:

- **Share to phone (direct)** — one click in Marker & Export streams the project
  straight from your computer to the phone over an encrypted WebRTC connection
  (PeerJS): scan the QR, keep the editor tab open while it loads. Nothing is
  uploaded to any server.
- **Publish (permanent)** — export the bundle zip, unzip into
  `public/projects/<id>/`, list it in `projects/index.json`, rebuild + push.

### Viewer interactions

Pinch to scale, drag to rotate, tap a pin or part for its description + highlight.
Effects: staggered entrance, idle float, camera-distance label LOD + proximity
focus, explode slider, double-tap isolate, X-ray, baked animation playback, and a
guided **tour** mode for presentations.

## Develop

```sh
npm install
npm run dev            # http://localhost:5173  (editor/preview testing)
```

The phone AR viewer needs **HTTPS** (camera). For on-device testing over LAN
(PowerShell): `$env:VITE_HTTPS=1; npm run dev` — serves HTTPS on your LAN IP; open
that IP on the phone.

## Samples

Sample projects live under [`public/projects/`](public/projects) as static bundles
(`project.json`, model, `targets.mind`, `card.png`) listed in
`public/projects/index.json`. Regenerate the demo model and its marker:

```sh
npm install --no-save canvas@2.11.2   # node-canvas, for the marker compiler
node scripts/makeSample.mjs                          # model + labels
node scripts/makeSampleMarker.mjs sample-human-body "https://<your-pages-url>/"
```

`makeSampleMarker.mjs` draws the card and compiles the `.mind` offline (Node),
mirroring the in-browser compiler — use it to pre-bake trackable samples.

> Note: the in-browser compiler relies on `requestAnimationFrame`, so it only runs
> in a real, visible browser tab (works on desktop Chrome and phones). Headless /
> background automation has no rAF — use the Node script there.

## Publish (GitHub Pages)

```sh
npm run build          # -> dist/ (base './', hash routing: Pages-safe)
```

Deploy `dist/` to the `gh-pages` branch. Exported user bundles: unzip into
`public/projects/<id>/`, add the id to `public/projects/index.json`, rebuild, and
republish. The printed QR then resolves to the project from any phone.

## Credits & inspiration

This project was inspired by and builds on the excellent work of others:

- **[mind-ar-js](https://github.com/hiukim/mind-ar-js)** by [hiukim](https://github.com/hiukim)
  — the web AR image-tracking engine at the heart of the viewer, and its in-browser
  target compiler (MIT).
- **[mind-ar-js-react](https://github.com/hiukim/mind-ar-js-react)** by
  [hiukim](https://github.com/hiukim) — the React integration pattern this project's
  viewer is modelled on.
- **[three.js](https://github.com/mrdoob/three.js)** — 3D rendering, model loaders
  (glTF/OBJ/STL), and the Draco / KTX2 / meshopt decoders bundled in
  [`public/decoders/`](public/decoders).
- **[PeerJS](https://github.com/peers/peerjs)** — WebRTC data channels for the
  direct device-to-device "Share to phone" transfer.
- **[React](https://react.dev)**, **[Vite](https://vitejs.dev)**,
  **[@react-three/fiber](https://github.com/pmndrs/react-three-fiber)** &
  **[drei](https://github.com/pmndrs/drei)**,
  **[qrcode](https://github.com/soldair/node-qrcode)**,
  **[JSZip](https://stuk.github.io/jszip/)**, and
  **[idb-keyval](https://github.com/jakearchibald/idb-keyval)**.

The bundled sample is a stylized demo model generated for this project (CC0).
Bring your own models — anatomy, scans, product parts — and label away.
