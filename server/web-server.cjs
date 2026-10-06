const fs = require('node:fs/promises')
const http = require('node:http')
const path = require('node:path')
const { handleYoutubeRequest } = require('./youtube.cjs')

const { handleDesktopDownload } = require('./desktop-download.cjs')

const root = path.resolve(__dirname, '..', 'dist')
const executable = path.resolve(__dirname, '..', 'bin', 'yt-dlp.exe')
const host = process.env.MEDIA_STUDIO_HOST || '127.0.0.1'
const port = Number(process.env.MEDIA_STUDIO_PORT || 4173)
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
}

const server = http.createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
  if (pathname === '/api/desktop-download') {
    await handleDesktopDownload(request, response)
    return
  }
  if (pathname === '/api/youtube') {
    await handleYoutubeRequest(request, response, {
      executable,
      jsRuntime: process.execPath,
      jsRuntimeIsElectron: false,
    })
    return
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end()
    return
  }

  try {
    const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    const filePath = path.resolve(root, relativePath)
    if ((!filePath.startsWith(`${root}${path.sep}`) && filePath !== path.join(root, 'index.html'))) {
      response.writeHead(403).end()
      return
    }
    const contents = await fs.readFile(filePath)
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
      'Content-Length': contents.length,
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(request.method === 'HEAD' ? undefined : contents)
  } catch {
    response.writeHead(404).end('Not found')
  }
})

server.listen(port, host, () => {
  console.log(`Local Media Studio web server: http://${host}:${port}`)
})
