const maxRemoteBytes = 512 * 1024 * 1024
const youtubeHosts = [
  'youtube.com', 'youtu.be', 'youtube-nocookie.com', 'googlevideo.com',
  'youtube.googleapis.com', 'youtubei.googleapis.com',
]
const youtubePageHosts = ['youtube.com', 'youtu.be', 'youtube-nocookie.com']
const mediaExtensions = new Set([
  '3gp', 'aac', 'aif', 'aiff', 'alac', 'amr', 'ape', 'au', 'avi', 'flac', 'flv',
  'm2ts', 'm4a', 'm4b', 'm4v', 'mka', 'mkv', 'mov', 'mp2', 'mp3', 'mp4', 'mpeg',
  'mpg', 'mts', 'mxf', 'oga', 'ogg', 'ogv', 'opus', 'ra', 'ts', 'vob', 'wav',
  'webm', 'wma', 'wmv', 'wv',
])
const extensionByMime: Record<string, string> = {
  'audio/aac': 'aac',
  'audio/flac': 'flac',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/opus': 'opus',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'video/mp4': 'mp4',
  'video/mpeg': 'mpeg',
  'video/quicktime': 'mov',
  'video/webm': 'webm',
  'video/x-msvideo': 'avi',
  'video/x-ms-wmv': 'wmv',
  'video/x-matroska': 'mkv',
}

function isYouTubeHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '')
  return youtubeHosts.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

export function isYouTubeUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl.trim())
    const host = url.hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '')
    return youtubePageHosts.some((domain) => host === domain || host.endsWith(`.${domain}`))
  } catch {
    return false
  }
}

function safeFileName(value: string): string {
  const name = value.split(/[\\/]/).pop()?.trim() ?? ''
  return Array.from(name, (character) => {
    const code = character.charCodeAt(0)
    return '<>:"/\\|?*'.includes(character) || code < 32 ? '_' : character
  }).join('')
}

function fileNameFromResponse(response: Response, url: URL, mimeType: string): string {
  const disposition = response.headers.get('content-disposition') ?? ''
  const encodedName = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  const plainName = disposition.match(/filename="?([^";]+)"?/i)?.[1]
  let name = ''
  try {
    name = decodeURIComponent(encodedName ?? plainName ?? '')
  } catch {
    name = plainName ?? ''
  }

  if (!name) {
    const pathName = url.pathname.split('/').pop() ?? ''
    try {
      name = decodeURIComponent(pathName)
    } catch {
      name = pathName
    }
  }

  name = safeFileName(name)
  if (!name || name.endsWith('.')) name = 'download'
  if (!/\.[a-z0-9]{1,8}$/i.test(name)) name += `.${extensionByMime[mimeType] ?? 'media'}`
  return name
}

async function readResponse(response: Response, mimeType: string, importedName?: string): Promise<File> {
  const declaredLength = Number(response.headers.get('content-length') ?? 0)
  if (declaredLength > maxRemoteBytes) throw new Error('This file is over the 512 MB direct-link limit.')
  const finalUrl = new URL(response.url)
  if (isYouTubeHost(finalUrl.hostname)) throw new Error('YouTube links are not supported. Use a direct media file URL instead.')

  const fileName = importedName ? safeFileName(importedName) : fileNameFromResponse(response, finalUrl, mimeType)
  const extension = fileName.split('.').pop()?.toLowerCase() ?? ''
  const isMediaType = mimeType.startsWith('audio/') || mimeType.startsWith('video/')
  if (!isMediaType && !mediaExtensions.has(extension)) {
    throw new Error('That link did not return a direct audio or video file.')
  }
  if (mimeType === 'text/html' || mimeType === 'application/json') {
    throw new Error('That link returned a web page, not a direct media file.')
  }

  if (!response.body) {
    const blob = await response.blob()
    if (blob.size > maxRemoteBytes) throw new Error('This file is over the 512 MB direct-link limit.')
    if (blob.size === 0) throw new Error('The direct media file is empty.')
    return new File([blob], fileName, { type: mimeType || blob.type })
  }

  const reader = response.body.getReader()
  const chunks: BlobPart[] = []
  let totalBytes = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    if (!value) continue
    totalBytes += value.byteLength
    if (totalBytes > maxRemoteBytes) {
      await reader.cancel()
      throw new Error('This file is over the 512 MB direct-link limit.')
    }
    chunks.push(value as Uint8Array<ArrayBuffer>)
  }

  if (totalBytes === 0) throw new Error('The direct media file is empty.')
  return new File(chunks, fileName, { type: mimeType })
}

export async function fetchDirectMedia(rawUrl: string): Promise<File> {
  let url: URL
  try {
    url = new URL(rawUrl.trim())
  } catch {
    throw new Error('Enter a valid direct media URL.')
  }

  if (url.protocol !== 'https:') throw new Error('Direct media links must use HTTPS.')
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not supported.')
  if (isYouTubeHost(url.hostname)) throw new Error('YouTube links can only be imported from the desktop app.')

  let response: Response
  try {
    response = await fetch(url, { mode: 'cors', credentials: 'omit', redirect: 'follow', signal: AbortSignal.timeout(5 * 60 * 1000) })
  } catch {
    throw new Error('Could not fetch that link. The source must allow cross-origin access (CORS).')
  }
  if (!response.ok) throw new Error(`The source returned HTTP ${response.status}.`)
  const mimeType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
  return readResponse(response, mimeType)
}

export async function fetchYoutubeMedia(rawUrl: string, mediaType: 'audio' | 'video', videoQuality = 480): Promise<File> {
  let response: Response
  try {
    response = await fetch('/api/youtube', {
      method: 'POST',
      signal: AbortSignal.timeout(16 * 60 * 1000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: rawUrl.trim(), mediaType, videoQuality }),
    })
  } catch {
    throw new Error('Could not reach the YouTube downloader service. Retry shortly or use the desktop app.')
  }
  if (!response.ok) {
    const detail = await response.json().catch(() => null)
    throw new Error(detail?.error || 'The YouTube downloader is unavailable on this deployment.')
  }
  const mimeType = (response.headers.get('content-type') ?? '').split(';', 1)[0].trim().toLowerCase()
  const encodedName = response.headers.get('x-media-name')
  if (!encodedName || (!mimeType.startsWith('audio/') && !mimeType.startsWith('video/'))) {
    throw new Error('The YouTube downloader returned an invalid response.')
  }
  return readResponse(response, mimeType, decodeURIComponent(encodedName))
}

