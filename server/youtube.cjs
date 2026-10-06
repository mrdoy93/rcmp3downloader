const { spawn } = require('node:child_process')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')

const maxImportedBytes = 512 * 1024 * 1024
const youtubeHosts = ['youtube.com', 'youtu.be', 'youtube-nocookie.com']
const cookieBrowsers = new Set(['brave', 'chrome', 'chromium', 'edge', 'firefox', 'opera', 'safari', 'vivaldi', 'whale'])
function videoFormatForQuality(quality = 480) {
  if (![360, 480, 720, 1080].includes(quality)) throw new Error('Choose a supported video quality: 360p, 480p, 720p, or 1080p.')
  return `bestvideo[ext=mp4][vcodec^=avc1][height<=${quality}]+bestaudio[ext=m4a]/bestvideo[height<=${quality}]+bestaudio/best[height<=${quality}]`
}
const videoFormat = videoFormatForQuality()

let activeWebImports = 0

function safeFileName(name) {
  return Array.from(path.basename(name), (character) => {
    const code = character.charCodeAt(0)
    return '<>:"/\\|?*'.includes(character) || code < 32 ? '_' : character
  }).join('')
}

function validateYoutubeUrl(value) {
  let url
  try {
    url = new URL(String(value).trim())
  } catch {
    throw new Error('Enter a valid YouTube URL.')
  }
  const hostname = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '')
  const isYoutube = youtubeHosts.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
  if (url.protocol !== 'https:' || url.username || url.password || !isYoutube) {
    throw new Error('Only HTTPS links from YouTube are accepted by the YouTube downloader.')
  }
  return url.href
}

async function youtubeAuthenticationArgs(temporaryDirectory, options = {}) {
  const cookiesFile = options.cookiesFile ?? process.env.YTDLP_COOKIES_FILE
  const cookiesBase64 = options.cookiesBase64 ?? process.env.YTDLP_COOKIES_BASE64
  const cookiesFromBrowser = options.cookiesFromBrowser ?? process.env.YTDLP_COOKIES_FROM_BROWSER
  const configuredMethods = [cookiesFile, cookiesBase64, cookiesFromBrowser].filter((value) => String(value || '').trim())
  if (configuredMethods.length > 1) {
    throw new Error('Configure only one YouTube cookie source: file, base64, or browser.')
  }

  if (cookiesFromBrowser) {
    const browser = String(cookiesFromBrowser).trim().toLowerCase()
    if (!cookieBrowsers.has(browser)) {
      throw new Error(`Unsupported cookie browser "${browser}". Use Chrome, Edge, Firefox, Brave, Chromium, Opera, Safari, Vivaldi, or Whale.`)
    }
    return ['--cookies-from-browser', browser]
  }

  if (cookiesFile) {
    const resolvedCookiesFile = path.resolve(String(cookiesFile).trim())
    await fs.access(resolvedCookiesFile)
    return ['--cookies', resolvedCookiesFile]
  }

  if (cookiesBase64) {
    const encodedCookies = String(cookiesBase64).replace(/\s/g, '')
    if (!encodedCookies || encodedCookies.length > 2 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encodedCookies)) {
      throw new Error('YTDLP_COOKIES_BASE64 is not valid base64 cookie data.')
    }
    const cookies = Buffer.from(encodedCookies, 'base64')
    const firstLine = cookies.toString('utf8', 0, Math.min(cookies.length, 64)).replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0]
    if (firstLine !== '# HTTP Cookie File' && firstLine !== '# Netscape HTTP Cookie File') {
      throw new Error('YTDLP_COOKIES_BASE64 must contain a Netscape-format cookies.txt file.')
    }
    const temporaryCookiesFile = path.join(temporaryDirectory, 'youtube-cookies.txt')
    await fs.writeFile(temporaryCookiesFile, cookies, { mode: 0o600 })
    return ['--cookies', temporaryCookiesFile]
  }

  return []
}

function runYtDlp(executable, args, jsRuntimeIsElectron) {
  return new Promise((resolve, reject) => {
    const environment = { ...process.env }
    if (jsRuntimeIsElectron) environment.ELECTRON_RUN_AS_NODE = '1'
    else delete environment.ELECTRON_RUN_AS_NODE
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      env: environment,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timeout = setTimeout(() => {
      child.kill()
      finish(new Error('The YouTube download took longer than 15 minutes and was stopped.'))
    }, 15 * 60 * 1000)

    function finish(error, result) {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      if (error) reject(error)
      else resolve(result)
    }

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
      if (stdout.length > 1024 * 1024) {
        child.kill()
        finish(new Error('The YouTube downloader returned too much output.'))
      }
    })
    child.stderr.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-16 * 1024)
    })
    child.on('error', (error) => finish(error))
    child.on('close', (code) => {
      if (settled) return
      if (code === 0) return finish(null, stdout)
      const detail = stderr.split(/\r?\n/).filter(Boolean).at(-1)?.replace(/^ERROR:\s*/i, '')
      if (/sign in to confirm you(?:'|’|\u2019)re not a bot/i.test(detail || '')) {
        const usedAuthentication = args.includes('--cookies') || args.includes('--cookies-from-browser')
        const message = usedAuthentication
          ? 'YouTube rejected the configured sign-in session. Refresh the YouTube cookies and try again.'
          : 'YouTube challenged this network. Use the Windows desktop app, or configure YouTube cookies for this server.'
        return finish(new Error(message))
      }
      finish(new Error(detail || 'YouTube could not provide a downloadable media stream.'))
    })
  })
}

async function downloadYoutubeToFile({ urlValue, mediaType, executable, jsRuntime, jsRuntimeIsElectron = false, videoQuality = 480, maxBytes = maxImportedBytes, cookiesFile, cookiesBase64, cookiesFromBrowser }) {
  const url = validateYoutubeUrl(urlValue)
  if (mediaType !== 'audio' && mediaType !== 'video') throw new Error('Choose a valid YouTube download type.')
  const format = mediaType === 'audio' ? 'bestaudio/best' : videoFormatForQuality(videoQuality)
  try {
    await fs.access(executable)
  } catch {
    throw new Error('The YouTube downloader is missing. Run npm run prepare:yt-dlp, then restart the app.')
  }

  let videoOptions = []
  if (mediaType === 'video') {
    // Packaged desktop builds place the merger beside yt-dlp. Development
    // and the local web server use the installed ffmpeg-static executable.
    let merger = path.join(path.dirname(executable), 'ffmpeg.exe')
    try {
      await fs.access(merger)
    } catch {
      merger = require('ffmpeg-static')
    }
    if (!merger) throw new Error('The video merger is missing. Run npm install, then restart the app.')
    await fs.access(merger)
    videoOptions = ['--ffmpeg-location', merger, '--merge-output-format', 'mp4', '--recode-video', 'mp4']
  }

  const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'local-media-studio-'))
  try {
    const authenticationOptions = await youtubeAuthenticationArgs(temporaryDirectory, { cookiesFile, cookiesBase64, cookiesFromBrowser })
    const outputTemplate = path.join(temporaryDirectory, '%(title).160B [%(id)s].%(ext)s')
    const output = await runYtDlp(executable, [
      '--no-config',
      '--no-playlist',
      ...authenticationOptions,
      '--socket-timeout', '30',
      '--retries', '3',
      '--extractor-retries', '3',
      '--fragment-retries', '3',
      '--max-filesize', String(maxBytes),
      '--format', format,
      ...videoOptions,
      '--output', outputTemplate,
      '--print', 'after_move:%(filepath)j',
      '--js-runtimes', `node:${jsRuntime}`,
      url,
    ], jsRuntimeIsElectron)
    const printedPath = String(output).split(/\r?\n/).filter(Boolean).at(-1)
    if (!printedPath) throw new Error('YouTube did not return the downloaded file path.')

    let downloadedPath
    try {
      downloadedPath = JSON.parse(printedPath)
    } catch {
      throw new Error('YouTube returned an unreadable downloaded file path.')
    }
    const resolvedPath = path.resolve(downloadedPath)
    const relativePath = path.relative(temporaryDirectory, resolvedPath)
    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      throw new Error('YouTube returned an unsafe downloaded file path.')
    }

    const stats = await fs.stat(resolvedPath)
    if (!stats.isFile() || stats.size === 0) throw new Error('YouTube returned an empty media file.')
    if (stats.size > maxBytes) throw new Error(`This video is over the ${Math.floor(maxBytes / 1024 / 1024)} MB download limit.`)
    const extension = path.extname(resolvedPath).toLowerCase()
    const type = mediaType === 'audio'
      ? ({ '.m4a': 'audio/mp4', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.opus': 'audio/opus', '.webm': 'audio/webm' }[extension] || 'audio/*')
      : ({ '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska' }[extension] || 'video/*')
    return {
      name: safeFileName(path.basename(resolvedPath)),
      path: resolvedPath,
      size: stats.size,
      type,
      cleanup: () => fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined),
    }
  } catch (error) {
    await fs.rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
}

async function downloadYoutubeMedia(options) {
  const result = await downloadYoutubeToFile(options)
  try {
    const contents = await fs.readFile(result.path)
    const data = contents.buffer.slice(contents.byteOffset, contents.byteOffset + contents.byteLength)
    return { name: result.name, data, type: result.type }
  } finally {
    await result.cleanup()
  }
}

async function readJsonBody(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > 16 * 1024) throw new Error('The request is too large.')
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    throw new Error('The request body must be valid JSON.')
  }
}

async function handleYoutubeRequest(request, response, options) {
  if (request.method !== 'POST') {
    response.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: 'Use POST for YouTube downloads.' }))
    return
  }
  if (activeWebImports >= 2) {
    response.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': '10' })
    response.end(JSON.stringify({ error: 'The server is already processing two downloads. Try again shortly.' }))
    return
  }

  activeWebImports += 1
  try {
    const body = await readJsonBody(request)
    const result = await downloadYoutubeMedia({
      urlValue: body.url,
      mediaType: body.mediaType,
      videoQuality: body.videoQuality,
      ...options,
    })
    const contents = Buffer.from(result.data)
    response.writeHead(200, {
      'Content-Type': result.type,
      'Content-Length': contents.length,
      'X-Media-Name': encodeURIComponent(result.name),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    response.end(contents)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not download that YouTube link.'
    response.writeHead(400, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    response.end(JSON.stringify({ error: message }))
  } finally {
    activeWebImports -= 1
  }
}

module.exports = { downloadYoutubeMedia, downloadYoutubeToFile, handleYoutubeRequest, videoFormat, videoFormatForQuality, youtubeAuthenticationArgs }
