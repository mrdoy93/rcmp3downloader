const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const ts = require('typescript')

async function createFlow(overrides = {}) {
  const source = await fs.readFile(path.join(__dirname, '../src/App.tsx'), 'utf8')
  const handler = source.slice(source.indexOf('  function addFiles('), source.indexOf('  function downloadDirectLink('))
    + source.slice(source.indexOf('  function downloadDirectLink('), source.indexOf('  async function deliverOutputs('))
    + source.slice(source.indexOf('  async function startConversion('), source.indexOf('  return (', source.indexOf('  function clearFinished(')))
  const calls = []
  const context = {
    isConverting: false, remoteUrl: 'https://example.com/sample.wav', itemsRef: { current: [] }, processingRef: { current: false },
    videoQuality: 480, format: 'mp3', bitrate: '320k', crypto: { randomUUID: (() => { let id = 0; return () => `download-${++id}` })() }, window: {}, Error, URL, Uint8Array,
    isYouTubeUrl: () => false,
    fetchDirectMedia: async () => ({ name: 'sample.wav', size: 1024 }), getFileKind: () => 'audio',
    convertMedia: async (file, format, bitrate, progress) => {
      calls.push(['convert', file.name, format, bitrate]); progress(50); return new Uint8Array([1, 2])
    },
    outputName: (name, format) => `${name.replace(/\.[^.]+$/, '')}.${format}`,
    deliverOutputs: async (outputs, batch, automatic) => {
      calls.push(['save', outputs[0].name, batch, automatic]); return 'Saved'
    },
    ...Object.fromEntries(['setIsConverting', 'setMessage', 'setLinkError', 'setLinkMessage', 'setRemoteUrl'].map(name => [name, value => calls.push([name, value])])),
    ...overrides,
  }
  context.updateItems = update => { context.itemsRef.current = update(context.itemsRef.current) }
  vm.createContext(context)
  vm.runInContext(ts.transpile(handler), context)
  const start = context.startConversion
  let drain
  context.startConversion = () => {
    const busy = context.processingRef.current
    const result = start()
    if (!busy) drain = result
    return result
  }
  return { context, calls, get items() { return context.itemsRef.current }, submit() { context.downloadDirectLink({ preventDefault() {} }) }, async drain() { await drain } }
}

async function runLink(overrides = {}) {
  const flow = await createFlow(overrides)
  flow.submit()
  await flow.drain()
  return { calls: flow.calls, items: flow.items }
}

test('link converts and saves MP3 with selected quality without a second click', async () => {
  const { calls, items } = await runLink()
  assert.deepEqual(calls.find(call => call[0] === 'convert'), ['convert', 'sample.wav', 'mp3', '320k'])
  assert.deepEqual(calls.find(call => call[0] === 'save'), ['save', 'sample.mp3', false, true])
  assert.equal(items[0].status, 'complete')
  assert.equal(items[0].progress, 100)
  assert.ok(calls.some(call => call[0] === 'setRemoteUrl' && call[1] === ''))
})

test('video link uses selected MP4 format', async () => {
  const { calls } = await runLink({ format: 'mp4', getFileKind: () => 'video' })
  assert.equal(calls.find(call => call[0] === 'convert')[2], 'mp4')
  assert.equal(calls.find(call => call[0] === 'save')[1], 'sample.mp4')
})

test('audio-only MP4 is rejected before conversion or saving', async () => {
  const { calls } = await runLink({ format: 'mp4' })
  assert.ok(!calls.some(call => ['convert', 'save'].includes(call[0])))
  assert.ok(!calls.some(call => call[0] === 'save'))
})

test('conversion failures are reported and busy state resets', async () => {
  const { calls, items } = await runLink({ convertMedia: async () => { throw new Error('Unsupported codec') } })
  assert.equal(items[0].status, 'error')
  assert.equal(items[0].error, 'Unsupported codec')
  assert.deepEqual(calls.at(-1), ['setIsConverting', false])
  assert.ok(!calls.some(call => call[0] === 'save'))
})

test('downloads can be added while conversion is busy', async () => {
  let release
  let started
  const running = new Promise(resolve => { started = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  let active = 0
  let maxActive = 0
  const conversions = []
  const flow = await createFlow({
    fetchDirectMedia: async url => ({ name: url.endsWith('second') ? 'second.mp4' : 'first.wav', size: 1024 }),
    getFileKind: file => file.name.endsWith('.mp4') ? 'video' : 'audio',
    convertMedia: async (file, format, bitrate) => {
      active++; maxActive = Math.max(maxActive, active)
      conversions.push([file.name, format, bitrate])
      if (file.name === 'first.wav') { started(); await blocked }
      active--
      return new Uint8Array([1])
    },
  })
  flow.submit()
  await running
  flow.context.format = 'mp4'
  flow.context.videoQuality = 720
  flow.context.remoteUrl = 'https://example.com/second'
  flow.submit()
  assert.equal(flow.items.length, 2)
  assert.equal(flow.items[1].status, 'queued')
  assert.equal(flow.items[1].videoQuality, 720)
  flow.context.format = 'mp3'
  flow.context.bitrate = '128k'
  release()
  await flow.drain()
  assert.equal(maxActive, 1)
  assert.deepEqual(conversions, [['first.wav', 'mp3', '320k'], ['second.mp4', 'mp4', '320k']])
  assert.ok(flow.items.every(item => item.status === 'complete' && item.file === null))
})

test('browser YouTube import converts and saves without requiring Electron', async () => {
  let requestedType
  const { calls, items } = await runLink({
    isYouTubeUrl: () => true,
    fetchYoutubeMedia: async (_url, type) => { requestedType = type; return { name: 'youtube.m4a' } },
    fetchDirectMedia: async () => { throw new Error('Wrong download path') },
  })
  assert.equal(requestedType, 'audio')
  assert.deepEqual(calls.find(call => call[0] === 'convert'), ['convert', 'youtube.m4a', 'mp3', '320k'])
  assert.equal(items[0].status, 'complete')
  assert.equal(items[0].file, null)
})

test('browser YouTube download failure is shown and resets busy state', async () => {
  const { calls, items } = await runLink({
    isYouTubeUrl: () => true,
    fetchYoutubeMedia: async () => { throw new Error('Video unavailable') },
  })
  assert.equal(items[0].error, 'Video unavailable')
  assert.deepEqual(calls.at(-1), ['setIsConverting', false])
  assert.ok(!calls.some(call => call[0] === 'convert'))
})

test('desktop automatic save skips dialogs and preserves existing downloads', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-download-test-'))
  try {
    const handlers = {}
    const electron = {
      app: { getPath: () => directory, whenReady: () => ({ then() {} }), on() {} },
      ipcMain: { handle: (name, handler) => { handlers[name] = handler } },
      dialog: { showSaveDialog() { throw new Error('Unexpected dialog') }, showOpenDialog() { throw new Error('Unexpected dialog') } },
    }
    const source = await fs.readFile(path.join(__dirname, '../electron/main.cjs'), 'utf8')
    vm.runInNewContext(source, {
      require: name => name === 'electron' ? electron : name === '../server/youtube.cjs' ? {} : require(name),
      __dirname, process, Buffer,
    })
    await fs.writeFile(path.join(directory, 'sample.mp3'), 'existing')
    const result = await handlers['save-outputs']({}, [{ name: 'sample.mp3', data: new Uint8Array([1, 2, 3]) }], true)
    assert.equal(result.saved, true)
    assert.equal(await fs.readFile(path.join(directory, 'sample.mp3'), 'utf8'), 'existing')
    assert.deepEqual(await fs.readFile(path.join(directory, 'sample (1).mp3')), Buffer.from([1, 2, 3]))
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('YouTube MP4 saves prepared video without browser re-encoding', async () => {
  const { calls, items } = await runLink({
    format: 'mp4', isYouTubeUrl: () => true, getFileKind: () => 'video',
    Uint8Array,
    fetchYoutubeMedia: async () => ({ name: 'youtube.mp4', type: 'video/mp4', arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }),
    convertMedia: async () => { throw new Error('MP4 must not be re-encoded') },
  })
  assert.equal(items[0].status, 'complete')
  assert.deepEqual(calls.find(call => call[0] === 'save'), ['save', 'youtube.mp4', false, true])
  assert.deepEqual(calls.at(-1), ['setIsConverting', false])
})

test('YouTube video download forwards the selected resolution', async () => {
  let requestedQuality
  const { items } = await runLink({
    format: 'mp4', videoQuality: 480, isYouTubeUrl: () => true, getFileKind: () => 'video', Uint8Array,
    fetchYoutubeMedia: async (_url, _type, quality) => {
      requestedQuality = quality
      return { name: 'youtube.mp4', type: 'video/mp4', arrayBuffer: async () => new Uint8Array([1]).buffer }
    },
  })
  assert.equal(requestedQuality, 480)
  assert.equal(items[0].status, 'complete')
})

test('desktop YouTube download forwards the selected resolution through the bridge', async () => {
  let requestedQuality
  const { items } = await runLink({
    format: 'mp4', videoQuality: 720, isYouTubeUrl: () => true, getFileKind: () => 'video', Uint8Array,
    File: class { constructor(_data, name, options) { this.name = name; this.type = options.type } async arrayBuffer() { return new Uint8Array([1]).buffer } },
    window: { desktopBridge: { importYoutube: async (_url, _type, quality) => {
      requestedQuality = quality
      return { name: 'desktop.mp4', type: 'video/mp4', data: new Uint8Array([1]).buffer }
    } } },
  })
  assert.equal(requestedQuality, 720)
  assert.equal(items[0].status, 'complete')
})

test('a failed download does not stop the next queued video', async () => {
  const flow = await createFlow({
    fetchDirectMedia: async url => {
      if (url.endsWith('sample.wav')) throw new Error('HTTP Error 403: Forbidden')
      return { name: 'next.mp4', size: 1024 }
    },
    getFileKind: () => 'video',
  })
  flow.submit()
  flow.context.format = 'mp4'
  flow.context.remoteUrl = 'https://example.com/next'
  flow.submit()
  await flow.drain()
  assert.equal(flow.items[0].status, 'error')
  assert.equal(flow.items[0].error, 'HTTP Error 403: Forbidden')
  assert.equal(flow.items[1].status, 'complete')
  assert.equal(flow.context.processingRef.current, false)
})

test('clear finished and remove waiting items preserve the active download', async () => {
  let release
  const blocked = new Promise(resolve => { release = resolve })
  const flow = await createFlow({ fetchDirectMedia: async () => { await blocked; return { name: 'sample.wav', size: 1024 } } })
  flow.submit()
  const activeId = flow.items[0].id
  flow.context.remoteUrl = 'https://example.com/waiting'
  flow.submit()
  flow.context.removeItem(activeId)
  assert.equal(flow.items.length, 2)
  flow.context.removeItem(flow.items[1].id)
  flow.context.clearFinished()
  assert.equal(flow.items.length, 1)
  assert.equal(flow.items[0].status, 'fetching')
  release()
  await flow.drain()
  assert.equal(flow.items[0].status, 'complete')
})

test('local audio and video added during conversion join the running queue', async () => {
  let release
  let started
  const running = new Promise(resolve => { started = resolve })
  const blocked = new Promise(resolve => { release = resolve })
  const conversions = []
  const flow = await createFlow({
    getFileKind: file => file.name.endsWith('.mp4') ? 'video' : 'audio',
    convertMedia: async (file, format) => {
      conversions.push([file.name, format])
      if (file.name === 'first.wav') { started(); await blocked }
      return new Uint8Array([1])
    },
  })
  flow.context.addFiles([{ name: 'first.wav', size: 1024 }])
  const drain = flow.context.startConversion()
  await running
  flow.context.format = 'mp4'
  flow.context.addFiles([{ name: 'second.mp4', size: 2048 }, { name: 'third.wav', size: 4096 }])
  assert.equal(flow.items.length, 3)
  assert.equal(flow.items[1].outputFormat, 'mp4')
  assert.equal(flow.items[2].outputFormat, 'mp3')
  release()
  await drain
  assert.deepEqual(conversions, [['first.wav', 'mp3'], ['second.mp4', 'mp4'], ['third.wav', 'mp3']])
  assert.ok(flow.items.every(item => item.status === 'complete' && item.file === null))
})

test('desktop folder shortcut opens the same Downloads directory used for automatic saving', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-folder-test-'))
  try {
    const handlers = {}
    let openedPath
    const electron = {
      app: { getPath: name => { assert.equal(name, 'downloads'); return directory }, whenReady: () => ({ then() {} }), on() {} },
      ipcMain: { handle: (name, handler) => { handlers[name] = handler } },
      shell: { openPath: async value => { openedPath = value; return '' } },
    }
    const source = await fs.readFile(path.join(__dirname, '../electron/main.cjs'), 'utf8')
    vm.runInNewContext(source, { require: name => name === 'electron' ? electron : name === '../server/youtube.cjs' ? {} : require(name), __dirname, process, Buffer })
    const result = await handlers['open-downloads']()
    assert.equal(result.opened, true)
    assert.equal(openedPath, directory)
    electron.shell.openPath = async () => 'Folder unavailable'
    const failure = await handlers['open-downloads']()
    assert.equal(failure.opened, false)
    assert.equal(failure.error, 'Folder unavailable')
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
