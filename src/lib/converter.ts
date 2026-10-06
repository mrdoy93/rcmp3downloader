import { FFmpeg, FFFSType } from '@ffmpeg/ffmpeg'

export type ConversionFormat = 'mp3' | 'mp4'

export async function convertMedia(
  file: File,
  format: ConversionFormat,
  bitrate: string,
  onProgress: (progress: number) => void,
): Promise<Uint8Array> {
  // A fresh worker releases the WebAssembly heap, including its high-water
  // allocation, on success and failure instead of retaining it while idle.
  const ffmpeg = new FFmpeg()
  const extension = file.name.split('.').pop()?.toLowerCase().replace(/[^a-z0-9]/g, '') || 'bin'
  const inputName = `source.${extension}`
  const outputName = format === 'mp3' ? 'converted.mp3' : 'converted.mp4'
  let lastProgress = -1
  const reportProgress = ({ progress }: { progress: number }) => {
    const percent = Math.floor(Math.min(99, Math.max(0, progress * 100)))
    if (percent !== lastProgress) {
      lastProgress = percent
      onProgress(percent)
    }
  }

  let timeout: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error('Conversion timed out. Try a shorter or smaller video.')), 15 * 60 * 1000)
  })
  const withDeadline = <T,>(operation: Promise<T>): Promise<T> => Promise.race([operation, deadline])

  ffmpeg.on('progress', reportProgress)
  try {
    // Same-origin assets need no extra Blob copies or persistent object URLs.
    await withDeadline(ffmpeg.load({
      coreURL: new URL('/ffmpeg/ffmpeg-core.js', window.location.href).href,
      wasmURL: new URL('/ffmpeg/ffmpeg-core.wasm', window.location.href).href,
    }))
    await withDeadline(ffmpeg.createDir('/input'))
    // WORKERFS reads the Blob on demand instead of copying the whole input
    // through an ArrayBuffer into FFmpeg's in-memory filesystem.
    await withDeadline(ffmpeg.mount(FFFSType.WORKERFS, { blobs: [{ name: inputName, data: file }] }, '/input'))
    const args = format === 'mp3'
      ? ['-y', '-i', `/input/${inputName}`, '-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-b:a', bitrate, outputName]
      : ['-y', '-i', `/input/${inputName}`, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-threads', '1', '-preset', 'ultrafast', '-crf', '23', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', outputName]

    const exitCode = await withDeadline(ffmpeg.exec(args))
    if (exitCode !== 0) throw new Error('This file or codec is not supported by the local conversion engine.')
    const result = await withDeadline(ffmpeg.readFile(outputName))
    if (typeof result === 'string') throw new Error('The conversion engine returned an invalid file.')
    onProgress(100)
    return result
  } finally {
    clearTimeout(timeout)
    ffmpeg.off('progress', reportProgress)
    ffmpeg.terminate()
  }
}
