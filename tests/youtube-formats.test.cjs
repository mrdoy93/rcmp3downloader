const { test } = require('node:test')
const assert = require('node:assert/strict')
const { spawnSync } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { videoFormatForQuality, youtubeAuthenticationArgs } = require('../server/youtube.cjs')

test('YouTube authentication accepts an explicitly selected local browser', async () => {
  const args = await youtubeAuthenticationArgs(os.tmpdir(), {
    cookiesFromBrowser: 'Firefox', cookiesFile: '', cookiesBase64: '',
  })
  assert.deepEqual(args, ['--cookies-from-browser', 'firefox'])
  await assert.rejects(
    youtubeAuthenticationArgs(os.tmpdir(), { cookiesFromBrowser: 'unknown', cookiesFile: '', cookiesBase64: '' }),
    /Unsupported cookie browser/,
  )
})

test('YouTube authentication materializes hosted cookie secrets inside the temporary download directory', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-cookie-test-'))
  try {
    const cookieText = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\ttest\tvalue\n'
    const args = await youtubeAuthenticationArgs(directory, {
      cookiesBase64: Buffer.from(cookieText).toString('base64'), cookiesFile: '', cookiesFromBrowser: '',
    })
    assert.equal(args[0], '--cookies')
    assert.equal(path.dirname(args[1]), directory)
    assert.equal(await fs.readFile(args[1], 'utf8'), cookieText)
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test('YouTube authentication rejects ambiguous or malformed cookie configuration', async () => {
  await assert.rejects(
    youtubeAuthenticationArgs(os.tmpdir(), { cookiesFile: 'cookies.txt', cookiesFromBrowser: 'edge', cookiesBase64: '' }),
    /only one YouTube cookie source/,
  )
  await assert.rejects(
    youtubeAuthenticationArgs(os.tmpdir(), { cookiesBase64: Buffer.from('not cookies').toString('base64'), cookiesFile: '', cookiesFromBrowser: '' }),
    /Netscape-format/,
  )
})

for (const combined of [false, true]) {
  test(`video selector supports ${combined ? 'combined fallback' : 'separate video and audio'}`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-format-test-'))
    try {
      const formats = combined ? [
        { format_id: '18', ext: 'mp4', height: 360, vcodec: 'avc1', acodec: 'mp4a' },
      ] : [
        { format_id: '136', ext: 'mp4', height: 720, vcodec: 'avc1.4d401f', acodec: 'none' },
        { format_id: '140', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2' },
      ]
      const fixture = path.join(directory, 'info.json')
      await fs.writeFile(fixture, JSON.stringify({ id: 'test', title: 'test', extractor: 'youtube',
        formats: formats.map(format => ({ ...format, url: 'https://example.com/media', protocol: 'https' })),
      }))
      const result = spawnSync(path.resolve(__dirname, '../bin/yt-dlp.exe'), [
        '--no-config', '--simulate', '--load-info-json', fixture, '--format', videoFormatForQuality(1080),
        '--print', '%(format_id)s', '--ffmpeg-location', require('ffmpeg-static'),
      ], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
      assert.equal(result.status, 0, result.stderr)
      assert.equal(result.stdout.trim(), combined ? '18' : '136+140')
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
}

test('video quality rejects unsupported or malformed resolutions', () => {
  for (const quality of [0, 2160, '720', '720]+best', null]) {
    assert.throws(() => videoFormatForQuality(quality), /supported video quality/)
  }
})

for (const quality of [360, 480, 720, 1080]) {
  test(`video selector respects ${quality}p and falls back to a lower resolution`, async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'media-quality-test-'))
    try {
      const formats = [360, 480, 720, 1080, 2160].map(height => ({
        format_id: String(height), height, ext: 'mp4', vcodec: 'avc1.4d401f', acodec: 'none',
        url: 'https://example.com/video', protocol: 'https',
      }))
      formats.push({ format_id: 'audio', ext: 'm4a', vcodec: 'none', acodec: 'mp4a.40.2', url: 'https://example.com/audio', protocol: 'https' })
      const fixture = path.join(directory, 'info.json')
      for (const available of [formats, formats.filter(f => f.height !== quality)]) {
        await fs.writeFile(fixture, JSON.stringify({ id: 'test', title: 'test', extractor: 'youtube', formats: available }))
        const result = spawnSync(path.resolve(__dirname, '../bin/yt-dlp.exe'), [
          '--no-config', '--simulate', '--load-info-json', fixture, '--format', videoFormatForQuality(quality),
          '--print', '%(format_id)s', '--ffmpeg-location', require('ffmpeg-static'),
        ], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
        const expected = Math.max(...available.filter(f => f.height <= quality).map(f => f.height))
        if (expected === -Infinity) assert.notEqual(result.status, 0)
        else {
          assert.equal(result.status, 0, result.stderr)
          assert.equal(result.stdout.trim(), `${expected}+audio`)
        }
      }
    } finally {
      await fs.rm(directory, { recursive: true, force: true })
    }
  })
}
