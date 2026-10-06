const { app, BrowserWindow, dialog, ipcMain, shell } = require('electron')
const fs = require('node:fs/promises')
const http = require('node:http')
const { createReadStream } = require('node:fs')
const { pipeline } = require('node:stream/promises')
const path = require('node:path')
const { downloadYoutubeMedia } = require('../server/youtube.cjs')

let assetServer

function safeFileName(name) {
  return Array.from(path.basename(name), (character) => {
    const code = character.charCodeAt(0)
    return '<>:"/\\|?*'.includes(character) || code < 32 ? '_' : character
  }).join('')
}

function ytDlpPath() {
  const root = app.isPackaged ? process.resourcesPath : app.getAppPath()
  return path.join(root, 'bin', 'yt-dlp.exe')
}

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.wasm': 'application/wasm',
}

function createWindow() {
  const window = new BrowserWindow({
    width: 800,
    height: 700,
    center: true,
    show: false,
    autoHideMenuBar: true,
    minWidth: 760,
    minHeight: 700,
    backgroundColor: '#181d17',
    title: 'Local Media Studio',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  })

  window.once('ready-to-show', () => window.show())

  if (process.argv.includes('--dev')) {
    window.loadURL('http://127.0.0.1:54123')
    return
  }

  const root = path.join(app.getAppPath(), 'dist')
  assetServer = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
      const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
      const filePath = path.resolve(root, relativePath)
      if (!filePath.startsWith(`${root}${path.sep}`) && filePath !== path.join(root, 'index.html')) {
        response.writeHead(403).end()
        return
      }
      const stats = await fs.stat(filePath)
      if (!stats.isFile()) { response.writeHead(404).end(); return }
      response.writeHead(200, {
        'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
        'X-Content-Type-Options': 'nosniff',
        'Content-Length': stats.size,
      })
      await pipeline(createReadStream(filePath), response)
    } catch {
      if (!response.headersSent) response.writeHead(404).end('Not found')
      else response.destroy()
    }
  })

  assetServer.listen(0, '127.0.0.1', () => {
    const address = assetServer.address()
    window.loadURL(`http://127.0.0.1:${address.port}`)
  })
}

ipcMain.handle('save-outputs', async (_event, files, automatic = false) => {
  if (!Array.isArray(files) || files.length === 0) return { saved: false }
  const names = files.map((file) => safeFileName(String(file.name)))

  if (automatic === true) {
    const directory = app.getPath('downloads')
    await fs.mkdir(directory, { recursive: true })
    for (let index = 0; index < files.length; index += 1) {
      const name = names[index] || `converted-${index + 1}`
      const extension = path.extname(name)
      const stem = path.basename(name, extension)
      for (let suffix = 0; ; suffix += 1) {
        const candidate = suffix === 0 ? name : `${stem} (${suffix})${extension}`
        try {
          await fs.writeFile(path.join(directory, candidate), Buffer.from(files[index].data.buffer, files[index].data.byteOffset, files[index].data.byteLength), { flag: 'wx' })
          break
        } catch (error) {
          if (error.code !== 'EEXIST') throw error
        }
      }
    }
    return { saved: true }
  }

  if (files.length === 1) {
    const extension = path.extname(names[0]).toLowerCase().slice(1)
    const selection = await dialog.showSaveDialog({
      defaultPath: names[0],
      filters: [{ name: extension.toUpperCase(), extensions: [extension] }],
    })
    if (selection.canceled || !selection.filePath) return { saved: false, cancelled: true }
    await fs.writeFile(selection.filePath, Buffer.from(files[0].data.buffer, files[0].data.byteOffset, files[0].data.byteLength))
    return { saved: true }
  }

  const selection = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
  if (selection.canceled || !selection.filePaths[0]) return { saved: false, cancelled: true }
  const directory = selection.filePaths[0]
  for (let index = 0; index < files.length; index += 1) {
    const safeName = names[index] || `converted-${index + 1}`
    await fs.writeFile(path.join(directory, safeName), Buffer.from(files[index].data.buffer, files[index].data.byteOffset, files[index].data.byteLength))
  }
  return { saved: true }
})

app.whenReady().then(createWindow)
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
app.on('before-quit', () => assetServer?.close())
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

ipcMain.handle('import-youtube', (_event, url, mediaType, videoQuality = 480) => downloadYoutubeMedia({
  urlValue: url,
  mediaType,
  videoQuality,
  executable: ytDlpPath(),
  jsRuntime: process.execPath,
  jsRuntimeIsElectron: true,
}))



ipcMain.handle('open-downloads', async () => {
  const directory = app.getPath('downloads')
  await fs.mkdir(directory, { recursive: true })
  const error = await shell.openPath(directory)
  return { opened: !error, error: error || undefined }
})
