import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import type { ARProject } from '../types'
import { DEFAULT_TRANSFORM, newProjectId } from '../types'
import {
  listLocalProjects,
  listStaticProjects,
  saveBlob,
  saveProjectDoc,
  deleteProject,
  type SampleIndexEntry,
} from '../store/projects'
import { formatFromFileName } from '../loaders/loadModel'

export default function Home() {
  const [local, setLocal] = useState<ARProject[]>([])
  const [samples, setSamples] = useState<SampleIndexEntry[]>([])
  const fileRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()

  const refresh = () => {
    listLocalProjects().then(setLocal)
    listStaticProjects().then(setSamples)
  }
  useEffect(refresh, [])

  const onFile = async (file: File) => {
    const format = formatFromFileName(file.name)
    if (!format) {
      alert('Unsupported format. Use .glb, .gltf, .obj or .stl')
      return
    }
    const id = newProjectId()
    const doc: ARProject = {
      id,
      name: file.name.replace(/\.[^.]+$/, ''),
      model: `model.${format}`,
      transform: { ...DEFAULT_TRANSFORM },
      labels: [],
      targets: [{ index: 0, role: 'main' }],
      markerStyle: 'single',
      cardOrientation: 'upright',
      animation: { autoplay: true },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await saveBlob('model', id, file)
    await saveProjectDoc(doc)
    navigate(`/editor/${id}`)
  }

  const localIds = new Set(local.map((p) => p.id))

  return (
    <div className="app-shell" style={{ overflowY: 'auto' }}>
      <div className="topbar">
        <span className="brand">AR Label Studio</span>
        <span className="muted small">label 3D models → print a card → view in AR on any phone</span>
        <span className="badge" title="If two devices show different builds, refresh the older one">build {__BUILD__}</span>
        <span className="spacer" />
        <button className="primary" onClick={() => fileRef.current?.click()}>
          + New project from 3D model
        </button>
        <input
          ref={fileRef}
          type="file"
          accept=".glb,.gltf,.obj,.stl"
          style={{ display: 'none' }}
          onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])}
        />
      </div>

      <div style={{ padding: 24, maxWidth: 1100, margin: '0 auto', width: '100%' }}>
        <h2 style={{ marginBottom: 6 }}>Sample projects</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Preloaded, pre-labeled models. Open one to explore or press Edit to make your own copy.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
          {samples.length === 0 && <div className="card muted">No samples bundled yet.</div>}
          {samples.map((s) => (
            <div key={s.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <h3 style={{ flex: 1 }}>{s.name}</h3>
                <span className="badge sample">sample</span>
              </div>
              {s.description && <div className="muted small">{s.description}</div>}
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <Link to={`/preview/${s.id}`}><button>3D preview</button></Link>
                <Link to={`/view/${s.id}`}><button>AR view</button></Link>
                <Link to={`/editor/${s.id}`}><button>Edit{localIds.has(s.id) ? '' : ' (copy)'}</button></Link>
              </div>
            </div>
          ))}
        </div>

        <h2 style={{ margin: '28px 0 6px' }}>My projects</h2>
        <p className="muted small" style={{ marginTop: 0 }}>
          Stored in this browser. Export a project from the editor to publish it for phones.
        </p>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 14 }}>
          {local.length === 0 && <div className="card muted">Nothing yet — create a project from a 3D model file.</div>}
          {local.map((p) => (
            <div key={p.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <h3>{p.name}</h3>
              <div className="muted small">
                {p.labels.length} label{p.labels.length === 1 ? '' : 's'} · {p.model} · updated{' '}
                {new Date(p.updatedAt).toLocaleDateString()}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
                <Link to={`/editor/${p.id}`}><button>Edit</button></Link>
                <Link to={`/preview/${p.id}`}><button>3D preview</button></Link>
                <button
                  className="danger"
                  onClick={async () => {
                    if (confirm(`Delete "${p.name}"?`)) {
                      await deleteProject(p.id)
                      refresh()
                    }
                  }}
                >
                  Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
