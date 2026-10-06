const path = require('node:path')
const { createReadStream } = require('node:fs')
const { stat } = require('node:fs/promises')
const { pipeline } = require('node:stream/promises')

async function handleDesktopDownload(request, response) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD' }).end()
    return
  }
  const installer = path.resolve(__dirname, '..', 'release', 'Local-Media-Studio-Setup.exe')
  try {
    const info = await stat(installer)
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Disposition': 'attachment; filename="Local-Media-Studio-Setup.exe"',
      'Content-Length': info.size,
      'X-Content-Type-Options': 'nosniff',
    })
    if (request.method === 'HEAD') response.end()
    else await pipeline(createReadStream(installer), response)
  } catch {
    if (response.headersSent) response.destroy()
    else response.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' }).end('The Windows installer is not available yet. Run npm run package:desktop to build it.')
  }
}

module.exports = { handleDesktopDownload }
