import JSZip from 'jszip'
import type { ARProject } from '../types'
import { loadBlob, type ResolvedProject } from '../store/projects'

/**
 * "Share to phone" without publishing: the project bundle is zipped and
 * uploaded to tmpfiles.org (free anonymous host, ~60 min retention) when the
 * user explicitly clicks Share. The QR then opens
 *   <site>/#/view/shared?src=<zip url>
 * and the viewer streams the bundle straight from the temp host. For anything
 * permanent, export the bundle and publish it into public/projects/ instead.
 */

const UPLOAD_ENDPOINT = 'https://tmpfiles.org/api/v1/upload'

export async function buildShareZip(doc: ARProject): Promise<Blob> {
  const zip = new JSZip()
  zip.file('project.json', JSON.stringify(doc))
  const model = await loadBlob('model', doc.id)
  if (!model) throw new Error('Model file missing from local storage')
  zip.file(doc.model, model)
  const mind = await loadBlob('mind', doc.id)
  if (mind) zip.file('targets.mind', mind)
  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE' })
}

/** Upload the zip; returns the direct-download URL. */
export async function uploadTemp(zip: Blob): Promise<string> {
  const fd = new FormData()
  fd.append('file', zip, 'arlabeler-project.zip')
  const res = await fetch(UPLOAD_ENDPOINT, { method: 'POST', body: fd })
  if (!res.ok) throw new Error(`Upload failed: HTTP ${res.status}`)
  const json = (await res.json()) as { data?: { url?: string } }
  const pageUrl = json.data?.url
  if (!pageUrl) throw new Error('Upload service returned no URL')
  // page URL -> direct download URL (tmpfiles convention)
  return pageUrl.replace('tmpfiles.org/', 'tmpfiles.org/dl/')
}

/** Load a shared bundle in the viewer (phone side). */
export async function resolveSharedProject(src: string): Promise<ResolvedProject | undefined> {
  const res = await fetch(src)
  if (!res.ok) return undefined
  const zip = await JSZip.loadAsync(await res.blob())
  // bundle may be flat or wrapped in a single folder — search for project.json
  const docEntry = zip.file(/(^|\/)project\.json$/)[0]
  if (!docEntry) return undefined
  const prefix = docEntry.name.slice(0, docEntry.name.length - 'project.json'.length)
  const doc = JSON.parse(await docEntry.async('string')) as ARProject

  const modelEntry = zip.file(prefix + doc.model)
  if (!modelEntry) return undefined
  const modelUrl = URL.createObjectURL(await modelEntry.async('blob'))

  const mindEntry = zip.file(prefix + 'targets.mind')
  const mindUrl = mindEntry ? URL.createObjectURL(await mindEntry.async('blob')) : undefined

  return { doc, modelUrl, mindUrl, source: 'shared' }
}

/** Extract the ?src= parameter from a react-router location search string. */
export function sharedSrcFromSearch(search: string): string | null {
  return new URLSearchParams(search).get('src')
}
