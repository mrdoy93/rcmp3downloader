import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin, type Connect } from 'vite'
import react from '@vitejs/plugin-react'

const require = createRequire(import.meta.url)
const { handleYoutubeRequest } = require('./server/youtube.cjs')
const { handleDesktopDownload } = require('./server/desktop-download.cjs')
const executable = fileURLToPath(new URL('./bin/yt-dlp.exe', import.meta.url))

function youtubeEndpoint(): Plugin {
  const middleware: Connect.NextHandleFunction = (request, response, next) => {
    if (request.url?.split('?')[0] === '/api/desktop-download') {
      void handleDesktopDownload(request, response).catch(next)
      return
    }
    if (request.url?.split('?')[0] !== '/api/youtube') {
      next()
      return
    }
    void handleYoutubeRequest(request, response, {
      executable,
      jsRuntime: process.execPath,
      jsRuntimeIsElectron: false,
    }).catch(next)
  }

  return {
    name: 'local-youtube-endpoint',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

export default defineConfig({
  plugins: [react(), youtubeEndpoint()],
  base: './',
})

