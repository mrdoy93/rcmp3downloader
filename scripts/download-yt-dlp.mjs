import { createHash } from 'node:crypto'
import { access, chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

const releaseApi = 'https://api.github.com/repos/yt-dlp/yt-dlp/releases/latest'
const platformAssets = {
  win32: {
    x64: 'yt-dlp.exe',
    ia32: 'yt-dlp_x86.exe',
    arm64: 'yt-dlp_arm64.exe',
  },
  linux: {
    x64: 'yt-dlp_linux',
    arm64: 'yt-dlp_linux_aarch64',
  },
}
const assetName = platformAssets[process.platform]?.[process.arch]

if (!assetName) {
  throw new Error(`The yt-dlp setup does not support ${process.platform}/${process.arch}.`)
}

const projectRoot = path.resolve(import.meta.dirname, '..')
const binDirectory = path.join(projectRoot, 'bin')
const destination = path.join(binDirectory, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp')

try {
  await access(destination)
  console.log(`Using cached ${path.relative(projectRoot, destination)}.`)
  process.exit(0)
} catch {
  // Download the official release below.
}

await mkdir(binDirectory, { recursive: true })
const headers = {
  Accept: 'application/vnd.github+json',
  'User-Agent': 'Local-Media-Studio-build',
  'X-GitHub-Api-Version': '2022-11-28',
}
const releaseResponse = await fetch(releaseApi, { headers })
if (!releaseResponse.ok) throw new Error(`Could not read the latest yt-dlp release (HTTP ${releaseResponse.status}).`)

const release = await releaseResponse.json()
const asset = release.assets?.find((candidate) => candidate.name === assetName)
if (!asset?.browser_download_url) throw new Error(`The latest yt-dlp release does not contain ${assetName}.`)
if (!String(asset.digest ?? '').startsWith('sha256:')) {
  throw new Error('The yt-dlp release did not provide a SHA-256 digest; refusing an unverified executable.')
}

console.log(`Downloading ${assetName} from yt-dlp ${release.tag_name}...`)
const binaryResponse = await fetch(asset.browser_download_url, { headers })
if (!binaryResponse.ok) throw new Error(`Could not download yt-dlp (HTTP ${binaryResponse.status}).`)
const binary = new Uint8Array(await binaryResponse.arrayBuffer())
if (binary.byteLength === 0 || binary.byteLength > 150 * 1024 * 1024) {
  throw new Error('The yt-dlp download has an unexpected size.')
}

const actualDigest = createHash('sha256').update(binary).digest('hex')
const expectedDigest = String(asset.digest).slice('sha256:'.length).toLowerCase()
if (actualDigest !== expectedDigest) throw new Error('The yt-dlp SHA-256 digest did not match the official release.')

const temporaryPath = `${destination}.download`
await rm(temporaryPath, { force: true })
await writeFile(temporaryPath, binary)
await chmod(temporaryPath, 0o755)
await rename(temporaryPath, destination)
console.log(`Verified and saved ${path.relative(projectRoot, destination)}.`)
