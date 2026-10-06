const { app, BrowserWindow, ipcMain } = require('electron')
const path = require('node:path')

ipcMain.handle('import-youtube', async () => ({ name: 'unsupported.txt', type: 'application/octet-stream', data: new ArrayBuffer(1) }))

app.whenReady().then(async () => {
  const window = new BrowserWindow({ width: 800, height: 700, show: false, webPreferences: { preload: path.resolve(__dirname, '../electron/preload.cjs'), contextIsolation: true, nodeIntegration: false } })
  try {
    await window.loadFile(path.resolve(__dirname, '../dist/index.html'))
    await new Promise(resolve => setTimeout(resolve, 500))
    const results = []
    results.push(await window.webContents.executeJavaScript(`(() => ({ mode: 'MP3', viewport: [innerWidth, innerHeight], page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight], settingsBottom: document.querySelector('.settings-panel').getBoundingClientRect().bottom, footerBottom: document.querySelector('.page-footer').getBoundingClientRect().bottom }))()`))
    await window.webContents.executeJavaScript(`document.querySelectorAll('.format-option')[1].click()`)
    await new Promise(resolve => setTimeout(resolve, 100))
    results.push(await window.webContents.executeJavaScript(`(() => ({ mode: 'MP4', viewport: [innerWidth, innerHeight], page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight], settingsBottom: document.querySelector('.settings-panel').getBoundingClientRect().bottom, footerBottom: document.querySelector('.page-footer').getBoundingClientRect().bottom }))()`))
    await window.webContents.executeJavaScript(`(async () => { for (let i = 0; i < 12; i++) { const input = document.querySelector('#direct-media-url'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'https://www.youtube.com/watch?v=layout' + i); input.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 10)); document.querySelector('.direct-link-form').requestSubmit(); await new Promise(r => setTimeout(r, 20)); } })()`)
    await new Promise(resolve => setTimeout(resolve, 200))
    results.push(await window.webContents.executeJavaScript(`(() => ({ mode: 'MP4 with long queue', rows: document.querySelectorAll('.file-row').length, pagination: document.querySelector('.queue-pagination')?.textContent, viewport: [innerWidth, innerHeight], page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight], footerBottom: document.querySelector('.page-footer').getBoundingClientRect().bottom }))()`))
    ipcMain.removeHandler('import-youtube')
    ipcMain.handle('import-youtube', async () => ({ name: 'layout.mp4', type: 'video/mp4', data: new ArrayBuffer(1) }))
    ipcMain.handle('save-outputs', async () => ({ saved: true }))
    await window.webContents.executeJavaScript(`(async () => { const input = document.querySelector('#direct-media-url'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, 'https://www.youtube.com/watch?v=complete'); input.dispatchEvent(new Event('input', { bubbles: true })); await new Promise(r => setTimeout(r, 10)); document.querySelector('.direct-link-form').requestSubmit(); })()`)
    await new Promise(resolve => setTimeout(resolve, 200))
    window.setSize(760, 700)
    await new Promise(resolve => setTimeout(resolve, 100))
    results.push(await window.webContents.executeJavaScript(`(() => ({ mode: 'MP4 with save message at minimum width', viewport: [innerWidth, innerHeight], page: [document.documentElement.scrollWidth, document.documentElement.scrollHeight], footerBottom: document.querySelector('.page-footer').getBoundingClientRect().bottom, settingsBottom: document.querySelector('.settings-panel').getBoundingClientRect().bottom, engineBottom: document.querySelector('.engine-note').getBoundingClientRect().bottom, result: document.querySelector('.result-message')?.textContent }))()`))
    console.log(JSON.stringify(results))
    if (results.some(result => result.page[0] > result.viewport[0] || result.page[1] > result.viewport[1] || result.footerBottom > result.viewport[1])) throw new Error('Desktop layout overflows the window')
    if (results[3].engineBottom > results[3].settingsBottom || !results[3].result) throw new Error('Save message does not fit')
    if (results[2].rows !== 3 || !results[2].pagination?.includes('of 4')) throw new Error('Queue pagination did not render')
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})
