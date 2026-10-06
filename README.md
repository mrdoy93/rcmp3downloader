# Local Media Studio

A local media converter for the web and Windows desktop. Audio and video conversion happens on the user's device. YouTube importing works in the desktop app, the local Node server, and the included Vercel Function, for media the user owns or has permission to download.

## Run the web app

```sh
npm install
npm run prepare:yt-dlp
npm run dev
```

## Run the desktop app

```sh
npm run dev:desktop
```

For the built browser app, run `npm run build` followed by `npm start`, then open `http://127.0.0.1:4173`. `npm run preview` also includes the local YouTube endpoint. A static file host alone cannot import YouTube videos.

### Vercel

The repository includes a Vercel Function for `/api/youtube`. Vercel runs the Linux build of `yt-dlp` and streams completed media back to the browser. Import the repository into Vercel normally; `vercel.json` selects the required build command and includes the downloader and FFmpeg binaries in the function.

Vercel imports are capped at 200 MB to leave room for merging inside the function's temporary storage, and the function duration still applies, so very large or long downloads can fail. YouTube can also occasionally challenge or block cloud-provider IP addresses; the Windows desktop app remains the most reliable option when that happens.

The first desktop run prepares Electron and downloads the official Windows `yt-dlp` executable, verifies its SHA-256 digest from the GitHub release, and caches it in `bin/`. YouTube imports work in the desktop app and the local web server. The packaged Electron runtime supplies the JavaScript engine required by current YouTube extraction.

## Build

```sh
npm run build
npm run package:desktop
```

The desktop packaging command creates `release/Local-Media-Studio-Setup.exe`. The download button at the bottom of the web app serves this installer through the local server. Keep the `release` directory beside the app when serving it.

YouTube MP4 downloads are merged or converted using native FFmpeg by the local downloader and saved directly, without an additional browser video encode.

## Conversion

- Convert common supported audio formats to MP3 at 128, 192, or 320 kbps.
- Extract audio from common supported video formats and save it as MP3.
- Convert video files to MP4. Audio-only files cannot be converted to video.
- Add direct HTTPS media URLs when the source permits downloads and allows browser CORS access.
- In the Windows desktop app, locally served browser app, or Vercel deployment, import a single YouTube video as audio or video using `yt-dlp`. Playlists are disabled; local imports are limited to 512 MB and Vercel imports to 200 MB.
- YouTube video imports offer 360p, 480p, 720p, and 1080p quality choices and select the best available streams up to the chosen resolution and use the bundled native FFmpeg merger when video and audio are separate. The merged source is then converted to the selected MP4 output on-device.
- Queue audio and video links or local files with separate output settings. Add items while the queue runs; each file processes in order. Web outputs download individually; desktop outputs save automatically to Downloads.

Codec support depends on the media engine. Files stay on-device except for retrieving a user-requested remote source, and users should download and convert only media they own or have permission to use. YouTube availability can change when YouTube changes its service; refresh the cached downloader by deleting `bin/yt-dlp.exe` and running `npm run prepare:yt-dlp` again.
