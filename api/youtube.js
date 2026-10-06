import { createReadStream } from 'node:fs'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { downloadYoutubeToFile } = require('../server/youtube.cjs')

export const config = {
  maxDuration: 300,
}

function requestBody(request) {
  if (request.body && typeof request.body === 'object') return request.body
  if (typeof request.body === 'string') return JSON.parse(request.body)
  throw new Error('The request body must be valid JSON.')
}

export default async function handler(request, response) {
  if (request.method !== 'POST') {
    response.status(405).setHeader('Allow', 'POST').json({ error: 'Use POST for YouTube downloads.' })
    return
  }

  let result
  try {
    const body = requestBody(request)
    const executable = path.resolve(process.cwd(), 'bin', process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')
    result = await downloadYoutubeToFile({
      urlValue: body.url,
      mediaType: body.mediaType,
      videoQuality: body.videoQuality,
      executable,
      jsRuntime: process.execPath,
      jsRuntimeIsElectron: false,
      // Leave room in Vercel's 500 MB /tmp volume for separate audio/video
      // streams and the merged output to coexist briefly.
      maxBytes: 200 * 1024 * 1024,
    })

    response.status(200)
    response.setHeader('Content-Type', result.type)
    response.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(result.name)}`)
    response.setHeader('X-Media-Name', encodeURIComponent(result.name))
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.flushHeaders?.()
    await pipeline(createReadStream(result.path), response)
  } catch (error) {
    if (!response.headersSent) {
      const message = error instanceof Error ? error.message : 'Could not download that YouTube link.'
      response.status(400).setHeader('Cache-Control', 'no-store').json({ error: message })
    } else {
      response.destroy(error instanceof Error ? error : undefined)
    }
  } finally {
    await result?.cleanup()
  }
}
