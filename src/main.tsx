import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// No StrictMode: its dev double-mount fights MindAR's camera/renderer lifecycle.
createRoot(document.getElementById('root')!).render(<App />)
