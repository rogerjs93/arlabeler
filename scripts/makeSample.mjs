// Generates a preloaded sample: a stylized multi-part "human body" GLB with
// named parts, plus a project.json with pre-authored labels. Run with:
//   node scripts/makeSample.mjs
// Output lands in public/projects/<id>/ ; the marker (targets.mind) is compiled
// in-browser later via the editor, or the sample ships preview/AR without it
// until a user generates one.
import * as THREE from 'three'
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js'
import { writeFileSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Minimal FileReader for Node: GLTFExporter embeds buffers via readAsDataURL.
if (typeof globalThis.FileReader === 'undefined') {
  globalThis.FileReader = class {
    onload = null
    onloadend = null
    onerror = null
    result = null
    #fire() {
      this.onload?.({ target: this })
      this.onloadend?.({ target: this })
    }
    async readAsDataURL(blob) {
      const buf = Buffer.from(await blob.arrayBuffer())
      this.result = `data:${blob.type || 'application/octet-stream'};base64,${buf.toString('base64')}`
      this.#fire()
    }
    async readAsArrayBuffer(blob) {
      this.result = await blob.arrayBuffer()
      this.#fire()
    }
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const outDir = join(__dirname, '..', 'public', 'projects')

const SKIN = 0xd9a066
const mat = (hex) => new THREE.MeshStandardMaterial({ color: hex, roughness: 0.7, metalness: 0.03 })

function part(name, geo, material, pos) {
  const m = new THREE.Mesh(geo, material)
  m.name = name
  m.position.set(...pos)
  return m
}

// ---- stylized body (Y-up, ~1.8 units tall, centered near origin) ----
const body = new THREE.Group()
body.name = 'Body'

body.add(part('Head', new THREE.SphereGeometry(0.16, 32, 24), mat(SKIN), [0, 0.78, 0]))
body.add(part('Neck', new THREE.CylinderGeometry(0.06, 0.07, 0.1, 20), mat(SKIN), [0, 0.64, 0]))

const torso = new THREE.CapsuleGeometry(0.19, 0.34, 8, 24)
body.add(part('Thorax', torso, mat(0xc98f5a), [0, 0.38, 0]))
body.add(part('Abdomen', new THREE.CapsuleGeometry(0.17, 0.12, 8, 24), mat(0xbf854f), [0, 0.13, 0]))

// arms
for (const side of [-1, 1]) {
  const s = side === -1 ? 'Left' : 'Right'
  body.add(part(`${s}UpperArm`, new THREE.CapsuleGeometry(0.05, 0.24, 6, 16), mat(SKIN), [side * 0.26, 0.42, 0]))
  body.add(part(`${s}Forearm`, new THREE.CapsuleGeometry(0.043, 0.22, 6, 16), mat(SKIN), [side * 0.3, 0.14, 0.02]))
  body.add(part(`${s}Hand`, new THREE.SphereGeometry(0.06, 16, 12), mat(SKIN), [side * 0.31, -0.02, 0.03]))
}
// legs
for (const side of [-1, 1]) {
  const s = side === -1 ? 'Left' : 'Right'
  body.add(part(`${s}Thigh`, new THREE.CapsuleGeometry(0.075, 0.28, 6, 16), mat(SKIN), [side * 0.09, -0.16, 0]))
  body.add(part(`${s}Shin`, new THREE.CapsuleGeometry(0.06, 0.28, 6, 16), mat(SKIN), [side * 0.09, -0.5, 0]))
  body.add(part(`${s}Foot`, new THREE.BoxGeometry(0.09, 0.06, 0.2), mat(0x9a6b3f), [side * 0.09, -0.68, 0.05]))
}

const exporter = new GLTFExporter()
// JSON glTF with embedded (data-URI) buffers; avoids the browser-only binary
// path. parseAsync keeps the process alive until embedding promises resolve.
const result = await exporter.parseAsync(body, { binary: false })
{
    const id = 'sample-human-body'
    const dir = join(outDir, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'model.gltf'), JSON.stringify(result))

    const now = Date.now()
    const L = (title, description, anchor, meshName, color, rank) => ({
      id: `l-${title.toLowerCase().replace(/\s+/g, '-')}`,
      title, description, anchor, meshName, color, rank,
    })
    const project = {
      id,
      name: 'Human Body (sample)',
      model: 'model.gltf',
      transform: { scale: 0.9, rotation: [0, 0, 0], offset: [0, 0, 0.15] },
      cardOrientation: 'upright',
      labels: [
        L('Head', 'Contains the brain and the major sense organs.', [0, 0.75, 0.16], 'Head', '#4cc9ff', 0),
        L('Thorax', 'The chest — houses the heart and lungs, protected by the rib cage.', [0.19, 0.4, 0.05], 'Thorax', '#ff5c7a', 0),
        L('Abdomen', 'Holds the digestive organs, liver, and kidneys.', [0.17, 0.15, 0.05], 'Abdomen', '#ffb04c', 1),
        L('Right Arm', 'Upper limb used for manipulation and reach.', [0.3, 0.3, 0.05], 'RightUpperArm', '#6ee86e', 1),
        L('Left Thigh', 'The largest bone of the body, the femur, sits here.', [-0.09, -0.16, 0.09], 'LeftThigh', '#9d7bff', 2),
        L('Right Foot', 'Bears body weight and enables walking.', [0.09, -0.68, 0.1], 'RightFoot', '#ff7bd5', 3),
      ],
      targets: [{ index: 0, role: 'main' }],
      markerStyle: 'single',
      animation: { autoplay: true },
      tourAutoSec: 8,
      attribution: 'Stylized demo model generated for AR Label Studio (CC0).',
      createdAt: now,
      updatedAt: now,
    }
    writeFileSync(join(dir, 'project.json'), JSON.stringify(project, null, 2))

    const index = [{ id, name: project.name, description: '6 labeled parts · tour + explode demo' }]
    writeFileSync(join(outDir, 'index.json'), JSON.stringify(index, null, 2))
    console.log('Wrote sample to', dir)
}
