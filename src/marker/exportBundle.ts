import JSZip from 'jszip'
import type { ARProject } from '../types'
import { loadBlob } from '../store/projects'

/**
 * Export a project as a static bundle zip: unzip into the site's
 * public/projects/<id>/ folder (and add the id to projects/index.json) to
 * publish it — the printed QR then resolves to it from any phone.
 */
export async function exportBundle(doc: ARProject): Promise<Blob> {
  const zip = new JSZip()
  const folder = zip.folder(doc.id)!
  folder.file('project.json', JSON.stringify(doc, null, 2))

  const model = await loadBlob('model', doc.id)
  if (!model) throw new Error('Model file missing from local storage')
  folder.file(doc.model, model)

  const mind = await loadBlob('mind', doc.id)
  if (mind) folder.file('targets.mind', mind)

  const card = await loadBlob('card', doc.id)
  if (card) folder.file('card.png', card)

  return zip.generateAsync({ type: 'blob' })
}

export function downloadBlob(blob: Blob, filename: string) {
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(a.href), 10000)
}
