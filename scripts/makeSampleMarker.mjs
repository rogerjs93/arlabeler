// Generates a printable marker card AND compiles its .mind tracking file for a
// sample project, entirely in Node (node-canvas + mind-ar OfflineCompiler).
// This ships the sample ready to track. For user projects the app compiles in
// the browser; this script is the offline equivalent for published samples.
//
//   node scripts/makeSampleMarker.mjs sample-human-body "https://rogerjs93.github.io/arlabeler/"
//
// Requires dev-only deps: `npm install --no-save canvas`
import { createCanvas, loadImage } from 'canvas'
import QRCode from 'qrcode'
import { OfflineCompiler } from 'mind-ar/src/image-target/offline-compiler.js'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const projectId = process.argv[2] || 'sample-human-body'
const baseUrl = (process.argv[3] || 'https://rogerjs93.github.io/arlabeler/').replace(/\/?$/, '/')
const dir = join(__dirname, '..', 'public', 'projects', projectId)

const project = JSON.parse(readFileSync(join(dir, 'project.json'), 'utf8'))
const viewerUrl = `${baseUrl}#/view/${projectId}`

// ---- deterministic feature pattern (mirrors the in-app card style) ----
function mulberry32(seed) {
  let a = seed
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
function seedFromString(s) {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return h >>> 0
}
const PALETTE = ['#e63946', '#f4a261', '#2a9d8f', '#264653', '#e9c46a', '#7b2d8b', '#1d7fb8', '#d1495b']
function drawShapeField(ctx, rng, x, y, w, h, count) {
  for (let i = 0; i < count; i++) {
    const cx = x + rng() * w, cy = y + rng() * h, size = 8 + rng() * 26
    const color = PALETTE[Math.floor(rng() * PALETTE.length)]
    ctx.save(); ctx.translate(cx, cy); ctx.rotate(rng() * Math.PI * 2)
    ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineWidth = 2 + rng() * 3
    const kind = Math.floor(rng() * 4)
    if (kind === 0) { ctx.beginPath(); ctx.arc(0, 0, size / 2, 0, Math.PI * 2); ctx.fill() }
    else if (kind === 1) { ctx.beginPath(); ctx.moveTo(-size/2, size/2); ctx.lineTo(size/2, size/2); ctx.lineTo(0, -size/2); ctx.closePath(); ctx.fill() }
    else if (kind === 2) { ctx.fillRect(-size/2, -size/4, size, size/2) }
    else { ctx.beginPath(); ctx.arc(0, 0, size/2, 0, Math.PI * (0.8 + rng())); ctx.stroke() }
    ctx.restore()
  }
}

const SIZE = 1000
const canvas = createCanvas(SIZE, SIZE)
const ctx = canvas.getContext('2d')
const rng = mulberry32(seedFromString(projectId))
ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, SIZE, SIZE)
const B = 190
drawShapeField(ctx, rng, 0, 0, SIZE, B, 70)
drawShapeField(ctx, rng, 0, SIZE - B, SIZE, B, 55)
drawShapeField(ctx, rng, 0, B, B, SIZE - 2 * B, 45)
drawShapeField(ctx, rng, SIZE - B, B, B, SIZE - 2 * B, 45)
ctx.strokeStyle = '#264653'; ctx.lineWidth = 5
ctx.strokeRect(B, B, SIZE - 2 * B, SIZE - 2 * B)
ctx.fillStyle = '#111318'; ctx.font = '700 64px sans-serif'; ctx.textAlign = 'center'
ctx.fillText(project.name, SIZE / 2, B + 110)
ctx.font = '400 30px sans-serif'; ctx.fillStyle = '#5b6472'
ctx.fillText('Scan the QR code, then point your phone at this card', SIZE / 2, B + 165)

const qrSize = 330
const qrDataUrl = await QRCode.toDataURL(viewerUrl, { margin: 2, width: qrSize, errorCorrectionLevel: 'M' })
const qrImg = await loadImage(qrDataUrl)
const qx = (SIZE - qrSize) / 2, qy = SIZE - B - qrSize - 60
ctx.fillStyle = '#fff'; ctx.fillRect(qx - 6, qy - 6, qrSize + 12, qrSize + 12)
ctx.drawImage(qrImg, qx, qy, qrSize, qrSize)
ctx.fillStyle = '#5b6472'; ctx.font = '400 26px sans-serif'
ctx.fillText('AR Label Studio', SIZE / 2, SIZE - B - 22)

writeFileSync(join(dir, 'card.png'), canvas.toBuffer('image/png'))
console.log('Wrote card.png')

// ---- compile .mind from a downscaled (512) copy of the card ----
const T = 512
const target = createCanvas(T, T)
target.getContext('2d').drawImage(canvas, 0, 0, T, T)
const targetImg = await loadImage(target.toBuffer('image/png'))

const compiler = new OfflineCompiler()
console.log('Compiling .mind (this takes ~10-40s)…')
await compiler.compileImageTargets([targetImg], (p) => {
  if (Math.round(p) % 10 === 0) process.stdout.write(`\r  progress ${Math.round(p)}%   `)
})
const buffer = compiler.exportData()
writeFileSync(join(dir, 'targets.mind'), Buffer.from(buffer))
console.log(`\nWrote targets.mind (${buffer.byteLength} bytes)`)

// ---- validate: re-import the file ----
const verify = new OfflineCompiler()
const imported = verify.importData(Buffer.from(buffer).buffer)
console.log(`Validated: ${imported.length} target(s) in the compiled file`)
