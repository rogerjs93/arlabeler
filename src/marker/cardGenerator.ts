import QRCode from 'qrcode'

/**
 * Generates printable marker cards. A card carries:
 *  - a QR code (phone's native camera -> opens the viewer URL), and
 *  - a moderately detailed, non-repetitive procedural pattern that gives MindAR
 *    the image features it needs for tracking (bare QR codes track poorly).
 *
 * Feature density is deliberately moderate: too many keypoints make MindAR's
 * compile pathologically slow and lower tracking FPS on phones. The print
 * canvas is high-res for paper; the tracking target is the same artwork
 * downscaled to TARGET_SIZE, which is all MindAR needs (it matches features,
 * not pixels).
 */

const CARD_SIZE = 1000 // print resolution (~210 dpi at 12 cm)
const TARGET_SIZE = 512 // resolution actually compiled into targets.mind

// deterministic RNG so a project's card looks the same every regeneration
function mulberry32(seed: number) {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function seedFromString(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

const PALETTE = ['#e63946', '#f4a261', '#2a9d8f', '#264653', '#e9c46a', '#7b2d8b', '#1d7fb8', '#d1495b']

function drawShapeField(
  ctx: CanvasRenderingContext2D,
  rng: () => number,
  x: number,
  y: number,
  w: number,
  h: number,
  count: number,
) {
  for (let i = 0; i < count; i++) {
    const cx = x + rng() * w
    const cy = y + rng() * h
    const size = 8 + rng() * 26
    const color = PALETTE[Math.floor(rng() * PALETTE.length)]
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(rng() * Math.PI * 2)
    ctx.fillStyle = color
    ctx.strokeStyle = color
    ctx.lineWidth = 2 + rng() * 3
    const kind = Math.floor(rng() * 5)
    if (kind === 0) {
      ctx.beginPath()
      ctx.arc(0, 0, size / 2, 0, Math.PI * 2)
      ctx.fill()
    } else if (kind === 1) {
      ctx.beginPath()
      ctx.moveTo(-size / 2, size / 2)
      ctx.lineTo(size / 2, size / 2)
      ctx.lineTo(0, -size / 2)
      ctx.closePath()
      ctx.fill()
    } else if (kind === 2) {
      ctx.fillRect(-size / 2, -size / 4, size, size / 2)
    } else if (kind === 3) {
      ctx.beginPath()
      ctx.arc(0, 0, size / 2, 0, Math.PI * (0.8 + rng()))
      ctx.stroke()
    } else {
      ctx.beginPath()
      ctx.moveTo(-size / 2, 0)
      for (let s = 1; s <= 3; s++) {
        ctx.lineTo(-size / 2 + (size / 3) * s, (rng() - 0.5) * size)
      }
      ctx.stroke()
    }
    ctx.restore()
  }
}

async function drawQR(ctx: CanvasRenderingContext2D, url: string, x: number, y: number, size: number) {
  const qrCanvas = document.createElement('canvas')
  await QRCode.toCanvas(qrCanvas, url, {
    width: size,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#111318', light: '#ffffff' },
  })
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(x - 6, y - 6, size + 12, size + 12)
  ctx.drawImage(qrCanvas, x, y, size, size)
}

export interface GeneratedCard {
  /** Full printable card (what the user prints). */
  printCanvas: HTMLCanvasElement
  /** Sub-images to compile as tracking targets (1 for single, 3 for tent faces). */
  targetCanvases: HTMLCanvasElement[]
}

/** Downscale a canvas so its longest side is TARGET_SIZE (cheaper, ample for tracking). */
function toTarget(src: HTMLCanvasElement): HTMLCanvasElement {
  const scale = TARGET_SIZE / Math.max(src.width, src.height)
  if (scale >= 1) return src
  const out = document.createElement('canvas')
  out.width = Math.round(src.width * scale)
  out.height = Math.round(src.height * scale)
  const ctx = out.getContext('2d')!
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(src, 0, 0, out.width, out.height)
  return out
}

/** One flat card: pattern frame + title + QR. */
export async function generateSingleCard(projectId: string, name: string, viewerUrl: string): Promise<GeneratedCard> {
  const c = document.createElement('canvas')
  c.width = CARD_SIZE
  c.height = CARD_SIZE
  const ctx = c.getContext('2d')!
  const rng = mulberry32(seedFromString(projectId))

  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, CARD_SIZE, CARD_SIZE)

  // feature frame (moderate density — enough distinct keypoints to track well)
  const B = 190
  drawShapeField(ctx, rng, 0, 0, CARD_SIZE, B, 70)
  drawShapeField(ctx, rng, 0, CARD_SIZE - B, CARD_SIZE, B, 55)
  drawShapeField(ctx, rng, 0, B, B, CARD_SIZE - 2 * B, 45)
  drawShapeField(ctx, rng, CARD_SIZE - B, B, B, CARD_SIZE - 2 * B, 45)

  // inner panel
  ctx.strokeStyle = '#264653'
  ctx.lineWidth = 5
  ctx.strokeRect(B, B, CARD_SIZE - 2 * B, CARD_SIZE - 2 * B)

  // title
  ctx.fillStyle = '#111318'
  ctx.font = '700 64px "Segoe UI", system-ui, sans-serif'
  ctx.textAlign = 'center'
  ctx.fillText(fitText(ctx, name, CARD_SIZE - 2 * B - 60), CARD_SIZE / 2, B + 110)
  ctx.font = '400 30px "Segoe UI", system-ui, sans-serif'
  ctx.fillStyle = '#5b6472'
  ctx.fillText('Scan the QR code, then point your phone at this card', CARD_SIZE / 2, B + 165)

  // QR bottom center of inner panel
  const qrSize = 330
  await drawQR(ctx, viewerUrl, (CARD_SIZE - qrSize) / 2, CARD_SIZE - B - qrSize - 60, qrSize)

  ctx.fillStyle = '#5b6472'
  ctx.font = '400 26px "Segoe UI", system-ui, sans-serif'
  ctx.fillText('AR Label Studio', CARD_SIZE / 2, CARD_SIZE - B - 22)

  return { printCanvas: c, targetCanvases: [toTarget(c)] }
}

/**
 * Fold-up tent: 3 face panels printed side by side with fold marks. Each face
 * is its own tracking target so tracking survives walking around the stand.
 */
export async function generateTentCard(projectId: string, name: string, viewerUrl: string): Promise<GeneratedCard> {
  const faceW = 700
  const faceH = 1000
  const faces: HTMLCanvasElement[] = []

  for (let f = 0; f < 3; f++) {
    const c = document.createElement('canvas')
    c.width = faceW
    c.height = faceH
    const ctx = c.getContext('2d')!
    const rng = mulberry32(seedFromString(`${projectId}:face${f}`))

    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, faceW, faceH)
    drawShapeField(ctx, rng, 0, 0, faceW, faceH, 130)

    // readable center panel
    ctx.fillStyle = 'rgba(255,255,255,0.94)'
    ctx.fillRect(70, 300, faceW - 140, 400)
    ctx.strokeStyle = '#264653'
    ctx.lineWidth = 4
    ctx.strokeRect(70, 300, faceW - 140, 400)

    ctx.fillStyle = '#111318'
    ctx.font = '700 44px "Segoe UI", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(fitText(ctx, name, faceW - 180), faceW / 2, 370)
    ctx.font = '400 26px "Segoe UI", system-ui, sans-serif'
    ctx.fillStyle = '#5b6472'
    ctx.fillText(`face ${f + 1} / 3`, faceW / 2, 415)

    const qrSize = 220
    await drawQR(ctx, viewerUrl, (faceW - qrSize) / 2, 440, qrSize)
    faces.push(c)
  }

  // assemble print sheet: 3 faces in a row + fold marks + instructions
  const gap = 4
  const sheet = document.createElement('canvas')
  sheet.width = faceW * 3 + gap * 2
  sheet.height = faceH + 90
  const sctx = sheet.getContext('2d')!
  sctx.fillStyle = '#ffffff'
  sctx.fillRect(0, 0, sheet.width, sheet.height)
  faces.forEach((f, i) => sctx.drawImage(f, i * (faceW + gap), 0))
  sctx.strokeStyle = '#9aa4b5'
  sctx.setLineDash([14, 10])
  sctx.lineWidth = 3
  for (let i = 1; i < 3; i++) {
    const x = i * (faceW + gap) - gap / 2
    sctx.beginPath()
    sctx.moveTo(x, 0)
    sctx.lineTo(x, faceH)
    sctx.stroke()
  }
  sctx.setLineDash([])
  sctx.fillStyle = '#5b6472'
  sctx.font = '400 30px "Segoe UI", system-ui, sans-serif'
  sctx.textAlign = 'center'
  sctx.fillText('Cut along the outline, fold on the dashed lines into a triangular stand (faces outward), tape the edge.', sheet.width / 2, faceH + 55)

  return { printCanvas: sheet, targetCanvases: faces.map(toTarget) }
}

/**
 * Multi-card scene: one card per target, each with its own pattern seed and a
 * subtitle naming what it renders. Printed as one sheet, cut apart.
 */
export async function generateMultiCardSet(
  projectId: string,
  name: string,
  viewerUrl: string,
  subtitles: string[],
): Promise<GeneratedCard> {
  const cardW = 700
  const cardH = 700
  const cards: HTMLCanvasElement[] = []

  for (let i = 0; i < subtitles.length; i++) {
    const c = document.createElement('canvas')
    c.width = cardW
    c.height = cardH
    const ctx = c.getContext('2d')!
    const rng = mulberry32(seedFromString(`${projectId}:card${i}`))

    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, cardW, cardH)
    drawShapeField(ctx, rng, 0, 0, cardW, cardH, 120)

    ctx.fillStyle = 'rgba(255,255,255,0.94)'
    ctx.fillRect(70, 190, cardW - 140, 330)
    ctx.strokeStyle = '#264653'
    ctx.lineWidth = 4
    ctx.strokeRect(70, 190, cardW - 140, 330)

    ctx.fillStyle = '#111318'
    ctx.font = '700 40px "Segoe UI", system-ui, sans-serif'
    ctx.textAlign = 'center'
    ctx.fillText(fitText(ctx, name, cardW - 180), cardW / 2, 250)
    ctx.font = '400 26px "Segoe UI", system-ui, sans-serif'
    ctx.fillStyle = '#5b6472'
    ctx.fillText(fitText(ctx, subtitles[i], cardW - 180), cardW / 2, 292)

    const qrSize = 190
    await drawQR(ctx, viewerUrl, (cardW - qrSize) / 2, 315, qrSize)
    cards.push(c)
  }

  const gap = 40
  const cols = Math.min(subtitles.length, 3)
  const rows = Math.ceil(subtitles.length / cols)
  const sheet = document.createElement('canvas')
  sheet.width = cols * cardW + (cols - 1) * gap
  sheet.height = rows * cardH + (rows - 1) * gap + 70
  const sctx = sheet.getContext('2d')!
  sctx.fillStyle = '#ffffff'
  sctx.fillRect(0, 0, sheet.width, sheet.height)
  cards.forEach((c, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    sctx.drawImage(c, col * (cardW + gap), row * (cardH + gap))
  })
  sctx.fillStyle = '#5b6472'
  sctx.font = '400 28px "Segoe UI", system-ui, sans-serif'
  sctx.textAlign = 'center'
  sctx.fillText('Cut the cards apart. Each card shows its own part of the model — arrange them together on a table.', sheet.width / 2, sheet.height - 25)

  return { printCanvas: sheet, targetCanvases: cards.map(toTarget) }
}

function fitText(ctx: CanvasRenderingContext2D, text: string, maxW: number): string {
  let t = text
  while (ctx.measureText(t).width > maxW && t.length > 1) t = t.slice(0, -1)
  return t === text ? t : t + '…'
}

export function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'),
  )
}
