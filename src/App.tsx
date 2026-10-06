import { useRef, useState, type DragEvent, type FormEvent } from 'react'
import {
  AudioLines,
  Check,
  ChevronDown,
  CircleAlert,
  Download,
  FileAudio2,
  FileVideo2,
  FolderOpen,
  HardDrive,
  Link2,
  LoaderCircle,
  Plus,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react'
import { convertMedia, type ConversionFormat } from './lib/converter'
import { fetchDirectMedia, fetchYoutubeMedia, isYouTubeUrl } from './lib/remoteMedia'
import './studio.css'

type FileKind = 'audio' | 'video'
type FileStatus = 'queued' | 'fetching' | 'converting' | 'saving' | 'complete' | 'error'
type QueueItem = {
  id: string
  file: File | null
  name: string
  size: number
  kind: FileKind
  status: FileStatus
  progress: number
  error?: string
  url?: string
  outputFormat: ConversionFormat
  bitrate: string
  videoQuality: number
}
type ConvertedFile = { name: string; data: Uint8Array }

declare global {
  interface Window {
    desktopBridge?: {
      openDownloads: () => Promise<{ opened: boolean; error?: string }>
      saveOutputs: (files: ConvertedFile[], automatic?: boolean) => Promise<{ saved: boolean; cancelled?: boolean }>
      importYoutube: (url: string, mediaType: FileKind, videoQuality?: number) => Promise<{ name: string; data: ArrayBuffer; type: string }>
    }
  }
}

const audioExtensions = new Set([
  'aac', 'aif', 'aiff', 'alac', 'amr', 'ape', 'au', 'flac', 'm4a', 'm4b',
  'mka', 'mp2', 'mp3', 'oga', 'ogg', 'opus', 'ra', 'wav', 'wma', 'wv',
])
const videoExtensions = new Set([
  '3gp', 'avi', 'flv', 'm2ts', 'm4v', 'mkv', 'mov', 'mp4', 'mpeg', 'mpg',
  'mts', 'mxf', 'ogv', 'ts', 'vob', 'webm', 'wmv',
])
const acceptedExtensions = [...audioExtensions, ...videoExtensions]
  .map((extension) => `.${extension}`)
  .join(',')

function getFileKind(file: File): FileKind | null {
  const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
  if (audioExtensions.has(extension) || file.type.startsWith('audio/')) return 'audio'
  if (videoExtensions.has(extension) || file.type.startsWith('video/')) return 'video'
  return null
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function sanitizeFileStem(name: string): string {
  const stem = name.replace(/\.[^.]+$/, '').trim()
  return Array.from(stem, (character) => {
    const code = character.charCodeAt(0)
    return '<>:"/\\|?*'.includes(character) || code < 32 ? '_' : character
  }).join('')
}

function outputName(name: string, format: ConversionFormat): string {
  const stem = sanitizeFileStem(name)
  return `${stem || 'converted-media'}.${format}`
}

function downloadFile(name: string, data: BlobPart, mimeType: string) {
  const url = URL.createObjectURL(new Blob([data], { type: mimeType }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function App() {
  const pickerRef = useRef<HTMLInputElement>(null)
  const [items, setItems] = useState<QueueItem[]>([])
  const itemsRef = useRef<QueueItem[]>([])
  const processingRef = useRef(false)
  const [format, setFormat] = useState<ConversionFormat>('mp3')
  const [videoQuality, setVideoQuality] = useState(480)
  const [bitrate, setBitrate] = useState('192k')
  const [isDragging, setIsDragging] = useState(false)
  const [isConverting, setIsConverting] = useState(false)
  const [remoteUrl, setRemoteUrl] = useState('')
  const [linkMessage, setLinkMessage] = useState('')
  const [linkError, setLinkError] = useState(false)
  const [queuePage, setQueuePage] = useState(0)
  const [message, setMessage] = useState('')

  const desktop = Boolean(window.desktopBridge)
  const queuedCount = items.filter((item) => item.status === 'queued').length
  const queuePages = Math.max(1, Math.ceil(items.length / 3))
  const currentQueuePage = Math.min(queuePage, queuePages - 1)
  const visibleItems = desktop ? items.slice(currentQueuePage * 3, currentQueuePage * 3 + 3) : items
  const readyToConvert = queuedCount > 0 && !isConverting

  function updateItems(update: (current: QueueItem[]) => QueueItem[]) {
    itemsRef.current = update(itemsRef.current)
    setItems(itemsRef.current)
  }

  function addFiles(fileList: FileList | File[]) {
    const additions: QueueItem[] = []
    const rejected: string[] = []
    for (const file of Array.from(fileList)) {
      const kind = getFileKind(file)
      if (!kind) {
        rejected.push(file.name)
        continue
      }
      if (itemsRef.current.some((item) => item.name === file.name && item.size === file.size) ||
        additions.some((item) => item.name === file.name && item.size === file.size)) continue
      additions.push({ id: crypto.randomUUID(), file, name: file.name, size: file.size, kind, status: 'queued', progress: 0, outputFormat: kind === 'audio' ? 'mp3' : format, bitrate, videoQuality })
    }
    if (additions.length) updateItems((current) => [...current, ...additions])
    setMessage(rejected.length ? `${rejected.length} unsupported file${rejected.length === 1 ? '' : 's'} skipped.` : '')
  }

  function handleDrop(event: DragEvent<HTMLElement>) {
    event.preventDefault()
    setIsDragging(false)
    addFiles(event.dataTransfer.files)
  }

  function downloadDirectLink(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const url = remoteUrl.trim()
    if (!url) return
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
        throw new Error('Enter an HTTPS media link without embedded credentials.')
      }
      const youtube = isYouTubeUrl(url)
      updateItems((current) => [...current, {
        id: crypto.randomUUID(), url, file: null, name: url, size: 0,
        kind: format === 'mp3' ? 'audio' : 'video', status: 'queued', progress: 0,
        outputFormat: format, bitrate, videoQuality,
      }])
      setLinkError(false)
      setLinkMessage(`${format.toUpperCase()} ${youtube && format === 'mp4' ? `${videoQuality}p ` : ''}added to the queue.`)
      setRemoteUrl('')
      void startConversion()
    } catch (error) {
      setLinkError(true)
      setLinkMessage(error instanceof Error ? error.message : 'Enter a valid media link.')
    }
  }

  async function processQueueItem(item: QueueItem) {
    const patch = (changes: Partial<QueueItem>) => updateItems((current) => current.map((entry) => entry.id === item.id ? { ...entry, ...changes } : entry))
    let file = item.file
    try {
      const youtube = Boolean(item.url && isYouTubeUrl(item.url))
      if (item.url) {
        patch({ status: 'fetching' })
        const mediaType = item.outputFormat === 'mp3' ? 'audio' : 'video'
        file = youtube
          ? window.desktopBridge
            ? await window.desktopBridge.importYoutube(item.url, mediaType, item.videoQuality)
              .then((result) => new File([result.data], result.name, { type: result.type }))
            : await fetchYoutubeMedia(item.url, mediaType, item.videoQuality)
          : await fetchDirectMedia(item.url)
      }
      if (!file) throw new Error('The source file is missing.')
      const kind = getFileKind(file)
      if (!kind) throw new Error('That link did not return a supported media file.')
      if (item.outputFormat === 'mp4' && kind === 'audio') {
        throw new Error('Choose MP3 for audio-only files. MP4 requires a video file.')
      }
      patch({ name: file.name, size: file.size, kind, status: 'converting' })
      const preparedMp4 = youtube && item.outputFormat === 'mp4' && file.type === 'video/mp4'
      const data = preparedMp4
        ? new Uint8Array(await file.arrayBuffer())
        : await convertMedia(file, item.outputFormat, item.bitrate, (progress) => patch({ progress }))
      patch({ status: 'saving', progress: 100 })
      setMessage(await deliverOutputs([{ name: outputName(file.name, item.outputFormat), data }], false, true))
      patch({ status: 'complete', file: null, progress: 100 })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      patch({ status: 'error', file: null, error: detail, progress: 0 })
    } finally {
      // Release each source before starting the next job.
      item.file = null
      file = null
    }
  }

  async function deliverOutputs(outputs: ConvertedFile[], isBatch: boolean, automatic = false) {
    if (desktop && window.desktopBridge) {
      const result = await window.desktopBridge.saveOutputs(outputs, automatic)
      if (result.cancelled) throw new Error('Save cancelled.')
      if (!result.saved) throw new Error('Could not save the converted file.')
      return result.saved && automatic ? 'Your converted file was saved to Downloads.' : result.saved ? `${outputs.length} file${outputs.length === 1 ? '' : 's'} saved on this device.` : 'Could not save the converted files.'
    }

    if (isBatch) {
      const { default: JSZip } = await import('jszip')
      const archive = new JSZip()
      outputs.forEach(({ name, data }) => archive.file(name, data))
      const zip = await archive.generateAsync({ type: 'blob' })
      downloadFile('converted-media.zip', zip, 'application/zip')
    } else {
      const output = outputs[0]
      const mimeType = output.name.endsWith('.mp4') ? 'video/mp4' : 'audio/mpeg'
      downloadFile(output.name, output.data as Uint8Array<ArrayBuffer>, mimeType)
    }
    return isBatch ? `Your ZIP contains ${outputs.length} converted files.` : 'Your converted file is ready.'
  }

  async function startConversion() {
    // The ref locks immediately, including two submissions before React renders.
    if (processingRef.current) return
    processingRef.current = true
    setIsConverting(true)
    setMessage('')
    try {
      while (true) {
        const item = itemsRef.current.find((entry) => entry.status === 'queued')
        if (!item) break
        await processQueueItem(item)
      }
    } finally {
      processingRef.current = false
      setIsConverting(false)
    }
  }

  async function openDownloads() {
    try {
      const result = await window.desktopBridge?.openDownloads()
      if (!result?.opened) throw new Error(result?.error || 'Could not open the Downloads folder.')
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Could not open the Downloads folder.')
    }
  }

  function removeItem(id: string) {
    updateItems((current) => current.filter((item) => item.id !== id || !['queued', 'complete', 'error'].includes(item.status)))
    setMessage('')
  }

  function clearFinished() {
    updateItems((current) => current.filter((item) => item.status !== 'complete' && item.status !== 'error'))
    setMessage('')
  }

  return (
    <div className={`app-shell${desktop ? ' desktop-app' : ''}`}>
      <header className="topbar">
        <a className="brand" href="#top" aria-label="Local Media Studio home">
          <span className="brand-mark"><AudioLines size={19} strokeWidth={2.2} /></span>
          <span>LOCAL <strong>MEDIA</strong> STUDIO</span>
        </a>
        <div className="topbar-status"><span className="status-dot" /> ON-DEVICE CONVERSION</div>
      </header>

      <main id="top" className="workspace">
        <div className="page-heading">
          <div>
            <p className="eyebrow">FILE CONVERTER <span> / </span> PRIVATE BY DESIGN</p>
            <h1>Make your media <em>move.</em></h1>
            <p className="subheading">Convert audio and video files right here on your device.</p>
          </div>
          <div className="privacy-note"><ShieldCheck size={17} /><span>Files never leave this device</span></div>
        </div>

        <section className="converter-layout" aria-label="Media converter">
          <div className="file-workspace">
            <form className="direct-link-form" onSubmit={downloadDirectLink}>
              <label className="direct-link-label" htmlFor="direct-media-url"><Link2 size={15} /> Media or YouTube URL</label>
              <div className="direct-link-controls">
                <input
                  id="direct-media-url"
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  placeholder='Paste a YouTube or direct media link'
                  value={remoteUrl}
                  onChange={(event) => setRemoteUrl(event.target.value)}
                />
                <button type="submit" disabled={!remoteUrl.trim()}>
                  <Plus size={15} />
                  {isConverting ? 'Add to queue' : 'Download'}
                </button>
              </div>
              <p className="direct-link-hint">YouTube single-video links and direct HTTPS media files are supported. Playlists are not imported.</p>
              {linkMessage && <p className={`direct-link-message${linkError ? ' is-error' : ''}`} role="status">{linkError ? <CircleAlert size={14} /> : <Check size={14} />}{linkMessage}</p>}
            </form>

            <div
              className={`dropzone${isDragging ? ' is-dragging' : ''}`}
              onDragEnter={(event) => { event.preventDefault(); setIsDragging(true) }}
              onDragOver={(event) => event.preventDefault()}
              onDragLeave={(event) => {
                if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragging(false)
              }}
              onDrop={handleDrop}
              onClick={() => pickerRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') pickerRef.current?.click()
              }}
              role="button"
              tabIndex={0}
              aria-label="Choose or drop audio and video files"
            >
              <input
                ref={pickerRef}
                className="visually-hidden"
                type="file"
                accept={acceptedExtensions}
                multiple
                onChange={(event) => {
                  if (event.target.files) addFiles(event.target.files)
                  event.target.value = ''
                }}
              />
              <div className="upload-icon"><Upload size={21} /></div>
              <div className="drop-copy">
                <strong>Drop your files here</strong>
                <span>or <span className="browse-link">browse files</span> from your device</span>
              </div>
              <span className="drop-formats">AUDIO + VIDEO <i /> COMMON FORMATS</span>
              <span className="drop-plus"><Plus size={18} /></span>
            </div>

            <div className="queue-heading">
              <div className="queue-title">
                <h2>Conversion queue</h2>
                <span className="queue-count">{items.length.toString().padStart(2, '0')}</span>
              </div>
              <div className="queue-actions">
                {items.some((item) => item.status === 'complete' || item.status === 'error') && (
                  <button className="text-action" type="button" onClick={clearFinished}>Clear finished</button>
                )}
                <button className="icon-button add-button" type="button" title="Add files" aria-label="Add files" onClick={() => pickerRef.current?.click()}>
                  <Plus size={17} />
                </button>
              </div>
            </div>

            {items.length === 0 ? (
              <div className="empty-queue">
                <div className="empty-glyph"><FolderOpen size={21} /></div>
                <span>Your queue is clear</span>
                <small>Add one or more files to get started</small>
              </div>
            ) : (
              <div className="file-list">
                {visibleItems.map((item) => {
                  const Icon = item.kind === 'video' ? FileVideo2 : FileAudio2
                  return (
                    <article className={`file-row file-${item.status}`} key={item.id}>
                      <div className={`file-type-icon ${item.kind}`}><Icon size={19} /></div>
                      <div className="file-info">
                        <div className="file-name-line"><span className="file-name" title={item.name}>{item.name}</span><span className="file-size">{item.size ? formatBytes(item.size) : 'LINK'}</span></div>
                        <small className="file-output">{item.outputFormat.toUpperCase()} {item.outputFormat === 'mp3' ? `${parseInt(item.bitrate)} kbps` : item.url && isYouTubeUrl(item.url) ? `${item.videoQuality}p` : 'original resolution'}</small>
                        <div className="file-progress-track" aria-label={`${item.progress}% complete`}>
                          <span style={{ width: `${item.progress}%` }} />
                        </div>
                        {item.status === 'error' && <small className="file-error" title={item.error}>{item.error}</small>}
                      </div>
                      <div className={`file-state ${item.status}`}>
                        {item.status === 'queued' && <span>QUEUED</span>}
                        {item.status === 'fetching' && <><LoaderCircle className="spin" size={15} /><span>DOWNLOADING</span></>}
                        {item.status === 'saving' && <><LoaderCircle className="spin" size={15} /><span>SAVING</span></>}
                        {item.status === 'converting' && <><LoaderCircle className="spin" size={15} /><span>{Math.round(item.progress)}%</span></>}
                        {item.status === 'complete' && <><Check size={15} /><span>DONE</span></>}
                        {item.status === 'error' && <><CircleAlert size={15} /><span>FAILED</span></>}
                      </div>
                      <button className="icon-button remove-button" type="button" title="Remove file" aria-label={`Remove ${item.name}`} onClick={() => removeItem(item.id)} disabled={!['queued', 'complete', 'error'].includes(item.status)}>
                        <X size={16} />
                      </button>
                    </article>
                  )
                })}
              </div>
            )}

            {desktop && items.length > 3 && <nav className="queue-pagination" aria-label="Queue pages">
              <button type="button" disabled={currentQueuePage === 0} onClick={() => setQueuePage(currentQueuePage - 1)}>Previous</button>
              <span>Page {currentQueuePage + 1} of {queuePages}</span>
              <button type="button" disabled={currentQueuePage === queuePages - 1} onClick={() => setQueuePage(currentQueuePage + 1)}>Next</button>
            </nav>}
            <div className="queue-footer">
              <div className="local-callout"><HardDrive size={15} /><span>Processed locally. No uploads, no account.</span></div>
              {desktop && <button className="downloads-folder-button" type="button" onClick={() => void openDownloads()}><FolderOpen size={15} /> Open Downloads</button>}
              {items.length > 0 && <span className="queue-summary">{queuedCount} {queuedCount === 1 ? 'file' : 'files'} waiting</span>}
            </div>
          </div>

          <aside className="settings-panel" aria-label="Output settings">
            <div className="settings-header">
              <span className="settings-index">01</span>
              <div><h2>Output format</h2><p>Choose what to create</p></div>
            </div>

            <div className="format-options" role="group" aria-label="Output format">
              <button className={`format-option${format === 'mp3' ? ' selected' : ''}`} type="button" onClick={() => setFormat('mp3')} aria-pressed={format === 'mp3'}>
                <span className="format-icon audio-format"><AudioLines size={19} /></span>
                <span className="format-copy"><strong>MP3 audio</strong><small>Extract or convert audio</small></span>
                <span className="format-radio" />
              </button>
              <button className={`format-option${format === 'mp4' ? ' selected' : ''}`} type="button" onClick={() => setFormat('mp4')} aria-pressed={format === 'mp4'}>
                <span className="format-icon video-format"><FileVideo2 size={19} /></span>
                <span className="format-copy"><strong>MP4 video</strong><small>Video files only</small></span>
                <span className="format-radio" />
              </button>
            </div>

            {format === 'mp3' ? (
              <label className="quality-field">
                <span className="field-label">AUDIO QUALITY</span>
                <span className="select-wrap">
                  <select value={bitrate} onChange={(event) => setBitrate(event.target.value)}>
                    <option value="128k">128 kbps Â· Smaller file</option>
                    <option value="192k">192 kbps Â· Balanced</option>
                    <option value="320k">320 kbps Â· Highest</option>
                  </select>
                  <ChevronDown size={16} />
                </span>
              </label>
            ) : (
              <div className="video-quality-settings">
                <label className="quality-field">
                  <span className="field-label">YOUTUBE VIDEO QUALITY</span>
                  <span className="select-wrap">
                    <select aria-label="YouTube video quality" value={videoQuality} onChange={(event) => setVideoQuality(Number(event.target.value))}>
                      <option value={360}>360p - Smaller file</option>
                      <option value={480}>480p - Standard</option>
                      <option value={720}>720p - HD</option>
                      <option value={1080}>1080p - Full HD</option>
                    </select>
                    <ChevronDown size={16} />
                  </span>
                </label>
                <p className="video-quality-hint">Downloads the best YouTube resolution up to your choice. Lower quality is used when needed. Local files and direct links keep their original resolution.</p>
                <div className="video-note"><FileVideo2 size={16} /><span>Exports video as MP4. Audio-only files cannot be converted to video.</span></div>
              </div>
            )}

            <button className="convert-button" type="button" onClick={startConversion} disabled={!readyToConvert}>
              {isConverting ? <><LoaderCircle className="spin" size={17} /> Processing queue...</> : <><Download size={17} /> Convert {queuedCount > 1 ? `${queuedCount} files` : 'file'}</>}
            </button>
            <p className="convert-footnote">{desktop ? 'Settings apply to new items. Files save to Downloads.' : 'Choose settings before adding each item. You can keep adding audio and video while the queue runs. Completed files download individually.'}</p>

            {message && <div className="result-message" role="status"><Check size={15} /><span>{message}</span></div>}

            <div className="settings-divider" />
            <div className="engine-note">
              <span className="engine-mark"><ShieldCheck size={16} /></span>
              <span><strong>Private by default</strong><small>Conversion runs in your browser or desktop app. Your media isnâ€™t uploaded.</small></span>
            </div>
          </aside>
        </section>

        {!desktop && <section className="desktop-download" aria-label="Download desktop application">
          <div><h2>Take your studio to desktop</h2><p>Download Local Media Studio for Windows. Convert files locally and save directly to your device.</p></div>
          <a
            className="desktop-download-button"
            href="https://github.com/mrdoy93/rcmp3downloader/releases/latest/download/Local-Media-Studio-Setup.exe"
          >
            <Download size={18} /> Download for Windows
          </a>
        </section>}

        <footer className="page-footer">
          <span>LOCAL MEDIA STUDIO <i /> CONVERT MEDIA YOU HAVE PERMISSION TO USE</span>
          <span>{desktop ? 'DESKTOP APP' : 'WEB APP'} <i /> NO REMOTE PROCESSING</span>
        </footer>
      </main>
      {message.includes('unsupported') && <div className="toast" role="status"><CircleAlert size={16} />{message}<button type="button" aria-label="Dismiss" onClick={() => setMessage('')}><X size={15} /></button></div>}
    </div>
  )
}

export default App






