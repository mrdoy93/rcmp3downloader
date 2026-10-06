const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

for (const failure of [null, 'load', 'mount', 'exec', 'readFile']) {
  test(`conversion releases worker after ${failure || 'success'}`, async () => {
    let terminated = 0
    let mounted
    const file = { name: 'input.wav', arrayBuffer() { throw new Error('Whole-file reads are forbidden') } }
    class FakeFFmpeg {
      on() {}
      off() {}
      terminate() { terminated++ }
      async load(config) {
        assert.equal(config.wasmURL, 'http://localhost/ffmpeg/ffmpeg-core.wasm')
        if (failure === 'load') throw new Error('load failed')
      }
      async createDir() {}
      async mount(type, options) {
        mounted = options.blobs[0].data
        assert.equal(type, 'WORKERFS')
        if (failure === 'mount') throw new Error('mount failed')
      }
      async exec(args) {
        assert.ok(args.includes('/input/source.wav'))
        return failure === 'exec' ? 1 : 0
      }
      async readFile() {
        if (failure === 'readFile') throw new Error('read failed')
        return new Uint8Array([1, 2])
      }
    }
    const source = await fs.readFile(path.join(__dirname, '../src/lib/converter.ts'), 'utf8')
    const exports = {}
    vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, {
      exports, require: () => ({ FFmpeg: FakeFFmpeg, FFFSType: { WORKERFS: 'WORKERFS' } }),
      setTimeout, clearTimeout, URL, window: { location: { href: 'http://localhost/' } },
    })
    const conversion = exports.convertMedia(file, 'mp3', '192k', () => {})
    if (failure) await assert.rejects(conversion)
    else assert.deepEqual(await conversion, new Uint8Array([1, 2]))
    assert.equal(terminated, 1)
    if (failure !== 'load') assert.equal(mounted, file)
  })
}

test('bundled FFmpeg converts a WORKERFS input to MP3', async () => {
  // Supply the synchronous Blob reader provided by browsers inside workers.
  const previousSelf = global.self
  global.self = { location: { href: 'http://localhost/ffmpeg/ffmpeg-core.js' } }
  const previousReader = global.FileReaderSync
  global.FileReaderSync = class { readAsArrayBuffer(blob) { return Uint8Array.from(blob.bytes).buffer } }
  try {
    const createCore = require('../node_modules/@ffmpeg/core/dist/umd/ffmpeg-core.js')
    const core = await createCore({ wasmBinary: await fs.readFile(path.join(__dirname, '../public/ffmpeg/ffmpeg-core.wasm')) })
    const logs = []
    core.setLogger(({ message }) => logs.push(message))
    const wav = Buffer.alloc(44 + 8000 * 2)
    wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8)
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22)
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34)
    wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40)
    const blob = { size: wav.length, bytes: wav, slice(start, end) { const bytes = wav.subarray(start, end); return { bytes, size: bytes.length } } }
    core.FS.mkdir('/input')
    core.FS.mount(core.FS.filesystems.WORKERFS, { blobs: [{ name: 'source.wav', data: blob }] }, '/input')
    core.exec('-i', '/input/source.wav', '-c:a', 'libmp3lame', '-b:a', '128k', 'out.mp3')
    assert.equal(core.ret, 0, logs.join('\n'))
    assert.ok(core.FS.readFile('out.mp3').length > 0)
    core.FS.unmount('/input')
  } finally {
    if (previousSelf === undefined) delete global.self
    else global.self = previousSelf
    if (previousReader === undefined) delete global.FileReaderSync
    else global.FileReaderSync = previousReader
  }
})



