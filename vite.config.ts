import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'

// base './' + hash routing keeps the build servable from any subpath (GitHub Pages).
// HTTPS is opt-in (VITE_HTTPS=1): phones need it for the camera, but plain HTTP
// is friendlier for desktop/editor testing. Run `npm run dev:https` for phones.
const useHttps = process.env.VITE_HTTPS === '1'

export default defineConfig({
  base: './',
  define: {
    // visible build stamp — lets users spot a stale cached bundle instantly
    __BUILD__: JSON.stringify(new Date().toISOString().slice(0, 16).replace('T', ' ')),
  },
  plugins: [react(), ...(useHttps ? [basicSsl()] : [])],
  server: {
    host: true, // expose on LAN so a phone can reach the dev server
  },
  build: {
    chunkSizeWarningLimit: 4000, // mind-ar bundles tfjs (~2 MB); expected
  },
})
