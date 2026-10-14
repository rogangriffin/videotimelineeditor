# Framecut

A local video timeline editor built with React, TypeScript, and Node.js. Arrange video, audio, and still images in your browser, save projects on disk, and render MP4 files through a background FFmpeg queue.

## Getting started

Use **Node.js 22.12 or later** and npm. A recent Chromium browser is recommended for media decoding and preview; supported input codecs depend on the browser.

```bash
git clone https://github.com/rogangriffin/videotimelineeditor.git
cd videotimelineeditor
npm ci
npm run dev
```

Open the localhost URL printed by Vite. The development server includes the storage and export APIs. Installation downloads FFmpeg and FFprobe through `ffmpeg-static` and `ffprobe-static`; a separate system installation is normally unnecessary.

For a production build:

```bash
npm run build
npm start
```

Open `http://127.0.0.1:4173`. `npm run preview` also serves the built app with its APIs. This application requires its Node.js server and cannot run on static hosting such as GitHub Pages. The server binds to loopback and rejects cross-origin API requests because it can access local files. Keep it local.

## Editing

- Import video, audio, or images into the media bin, then drag them onto the timeline or double-click to append them.
- Use two video tracks (`V1`, `V2`) and two audio tracks (`A1`, `A2`). Video with audio creates linked clips that move, trim, and split together.
- Drag clips to move them, drag their edges to trim, and use the razor or split command to cut. Snapping, track locking, track visibility/muting, and undo/redo are available.
- Import PNG, JPEG, WebP, GIF, BMP, and AVIF images. Stills start at five seconds and can be extended without a source-duration limit. Animated images use their first frame. Images fit within the sequence while preserving aspect ratio and transparency when composited.
- Click or drag the ruler to seek. Use **Sequence settings** to choose dimensions and a frame rate of 24, 25, 30, or 60 fps. The first video added to an untouched, empty sequence sets its dimensions when within the supported size limits, and selects the nearest supported frame rate.

### Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| Space | Play / pause |
| V | Selection tool |
| C | Razor tool |
| S | Split the selected clip at the playhead |
| Delete / Backspace | Delete the selected clip |
| Left / Right arrow | Previous / next frame |
| Ctrl+S / Cmd+S | Save project |
| Ctrl+Z / Cmd+Z | Undo |
| Ctrl+Shift+Z / Cmd+Shift+Z | Redo |
| Shift while dragging | Temporarily bypass snapping |

## Media and projects

**Import** opens a browser for folders on the server's disk. Navigate folders or paste an absolute folder path, including a path on another drive. Imported files remain at their original locations; Framecut stores their paths without making an extra server-side copy. Dragging files into the editor instead uploads persistent copies to the server because browser drag-and-drop does not expose original absolute paths.

**Save** writes the project to disk. **Save as new** creates a separate project, and **Open** lists saved projects and offers **New project**. Rename a project using its title. The last saved or opened project reopens automatically in the same browser. Edits are saved explicitly; the app indicates unsaved changes and prompts before leaving. Conflicting saves from multiple tabs are rejected: reopen the latest version or use **Save as new**.

Projects preload complete source files into browser memory for preview and seeking. Playback uses those local files and prepares upcoming clips. Large sources increase opening time and memory use. Files are shared between clips within a project, retained for undo/redo, and fetched again after a page reload.

Moved, removed, or changed source files appear offline. Use **Find file** to locate the original source, or upload a replacement, then save. Replacements must match the original name, size, and duration. **Retry loading media** retries failed downloads.

## MP4 export

1. Optionally right-click the timeline and choose **Mark Export Start** and **Mark Export End**. Both markers are required to restrict the export range; otherwise the full sequence is exported. Markers snap to frames, support undo/redo, and save with the project.
2. Click **Export MP4**, then **Render** in the exports dialog. The job captures the current sequence and track visibility, including unsaved edits. Hidden video and muted audio tracks are excluded.
3. Follow progress in the dialog. Completed files are saved in `data/exports/` and can also be downloaded using **Download MP4**.

Exports run on the local Node.js server using FFmpeg and read source files directly from disk. They continue after the dialog or browser tab closes, provided the server stays running. Up to four active jobs can be queued, and jobs render one at a time. Queued or running exports can be cancelled. Completed job history survives server restarts; interrupted jobs must be started again.

Output uses H.264 video and AAC audio when audio tracks are present. Export preserves cuts, layers, still images, audio offsets, and empty gaps within the selected range. Compatible, unedited full-length streams can be copied without re-encoding; trimmed or composed sequences are rendered.

The server probes Intel Quick Sync, NVIDIA NVENC, and AMD AMF before falling back to software H.264 (`libx264`). Hardware support depends on the bundled FFmpeg build, GPU, and drivers. If hardware rendering fails after initialization, the job retries with software encoding. Odd-sized frames use software encoding.

## Local storage and configuration

By default, server data lives in `data/` beside the app:

| Folder | Contents |
| --- | --- |
| `projects/` | Saved timelines, media metadata, thumbnails, and revisions |
| `sources/` | Registered absolute source paths and file fingerprints |
| `media/` | Persistent copies of uploaded media |
| `exports/` | Rendered MP4 files, job records, and diagnostic logs |

Back up this directory along with any referenced original media outside it. Imported and uploaded sources are retained even when unused by a project. Project documents use JSON internally; the project browser does not import legacy downloaded project JSON files.

Set environment variables in the shell before starting the server:

| Variable | Purpose |
| --- | --- |
| `FRAMECUT_DATA_DIR` | Absolute path to a different data directory |
| `PORT` | Port for `npm start` (default: `4173`) |
| `FRAMECUT_FFMPEG` | Path to an alternative FFmpeg executable |
| `FRAMECUT_FFPROBE` | Path to an alternative FFprobe executable |
| `FRAMECUT_ENCODER` | Select `h264_qsv`, `h264_nvenc`, `h264_amf`, or `libx264` instead of automatic detection |

An explicitly selected encoder must pass its initialization check. For predictable software rendering, set `FRAMECUT_ENCODER=libx264`.

PowerShell example:

```powershell
$env:FRAMECUT_DATA_DIR = 'D:\FramecutData'
$env:FRAMECUT_ENCODER = 'libx264'
npm run dev
```

The repository excludes local data, dependencies, build output, environment files, and logs. Keep personal media and project backups outside the source folders.

## Development and checks

```bash
npm test
npm run build
```

`npm test` covers storage persistence, imports and uploads, missing/changed sources, HTTP range requests, project validation, concurrent saves, origin protection, image duration and fitting, export markers, client media loading, and playback transport. Native export tests invoke FFmpeg and FFprobe to verify rendered video/audio, transparency, gaps, direct copying, persistence, and cancellation. `npm run build` checks TypeScript and creates the production bundle.

For manual browser checks, run Vite with a temporary data directory so generated fixtures stay separate from real projects:

```powershell
$env:FRAMECUT_DATA_DIR = Join-Path $env:TEMP ('framecut-checks-' + [guid]::NewGuid())
npm run dev
```

Visit these paths on the Vite server and click their run buttons:

- `/tests/browser-images.html`: image import, fitting, save/reopen, and browser-rendered MP4 pixel checks.
- `/tests/browser-client-media.html`: complete media loading, preview pixels, decoded audio, readiness, clip transitions, and playback stability with subsequent server media requests blocked.

These pages create test media and saved projects. They also exercise the browser renderer retained in `src/export.ts`; the editor's **Export MP4** button uses the server queue.

### Project layout

| Path | Purpose |
| --- | --- |
| `src/` | React editor, timeline model, preview transport, and storage/export dialogs |
| `server/` | Local HTTP storage API, FFmpeg export planning and queue, and automated tests |
| `tests/` | Manual browser integration checks |
| `vite.config.ts` | Vite setup and local API middleware |
