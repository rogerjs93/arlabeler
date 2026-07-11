import { HashRouter, Routes, Route } from 'react-router-dom'
import Home from './pages/Home'
import Editor from './pages/Editor/Editor'
import ARView from './pages/ARView'
import Preview from './pages/Preview'

export default function App() {
  return (
    <HashRouter>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/editor/:id" element={<Editor />} />
        <Route path="/view/:id" element={<ARView />} />
        <Route path="/preview/:id" element={<Preview />} />
      </Routes>
    </HashRouter>
  )
}
