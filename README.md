# @pico-brief/audio-info

A JavaScript/TypeScript library that reads audio files and tells you:

- How long the audio is (**duration**)
- If it has named sections (**chapters**)
- If it has embedded images (**album art**)

You give it the raw bytes of an audio file, and it hands back the metadata — no external programs or native tools required. It works in both Node.js and the browser.

## Supported formats

| Format              | Duration | Chapters | Album Art |
|---------------------|:--------:|:--------:|:---------:|
| MP3                 | ✓        | ✓        | ✓         |
| FLAC                | ✓        | ✓        | ✓         |
| OGG (Vorbis / Opus) | ✓        | ✓        | ✓         |
| MP4 / M4A / AAC     | ✓        | ✓        | ✓         |
| WAV                 | ✓        | —        | —         |

## Installation

```bash
npm install @pico-brief/audio-info
```

## Quick start

### In Node.js

```typescript
import audioInfo from '@pico-brief/audio-info'
import { readFileSync, writeFileSync } from 'fs'

// Step 1: read the audio file into memory
const buffer = new Uint8Array(readFileSync('my-song.mp3')).buffer

// Step 2: pass the buffer to audioInfo
const info = audioInfo(buffer)

// Step 3: use the results
console.log(`Duration: ${info.duration.toFixed(1)} seconds`)
// → Duration: 213.4 seconds

console.log(`Chapters: ${info.chapters.length}`)
// → Chapters: 3

console.log(`Album art images: ${info.albumArt.length}`)
// → Album art images: 1

// Print each chapter
info.chapters.forEach(ch => {
    console.log(`  [${ch.id}] "${ch.title}" — ${ch.startTime}s to ${ch.endTime}s`)
})

// Save the first album art image to disk
if (info.albumArt.length > 0) {
    const art = info.albumArt[0]
    writeFileSync('cover.jpg', Buffer.from(art.data))
    console.log(`Saved ${art.mimeType} image (${art.size} bytes)`)
}
```

### In the browser

```javascript
import audioInfo from '@pico-brief/audio-info'

// Use a file input to let the user pick an audio file
const input = document.querySelector('input[type="file"]')

input.addEventListener('change', async () => {
    const file = input.files[0]

    // browser files have a built-in .arrayBuffer() method
    const buffer = await file.arrayBuffer()

    const info = audioInfo(buffer)
    console.log(`Duration: ${info.duration.toFixed(1)} seconds`)
})
```

## API

### `audioInfo(buffer: ArrayBuffer): AudioInfo`

Pass in the raw bytes of any supported audio file and get back its metadata.

**Returns** an `AudioInfo` object:

```typescript
{
    duration: number,         // Total length of the audio in seconds (e.g. 213.4)
    chapters: ChapterInfo[],  // Named sections — empty array if none exist
    albumArt: AlbumArtInfo[], // Embedded images — empty array if none exist
}
```

---

### `ChapterInfo`

Describes a single named section of the audio.

```typescript
{
    id: number,         // Index of this chapter, starting at 0
    startTime: number,  // When the chapter begins, in seconds
    endTime: number,    // When the chapter ends, in seconds
    title?: string,     // Chapter name — not always present
}
```

---

### `AlbumArtInfo`

Describes a single embedded image.

```typescript
{
    type: string,        // What the image represents, e.g. "Cover (front)"
    mimeType: string,    // Image format, e.g. "image/jpeg" or "image/png"
    description: string, // Text description — often an empty string
    data: ArrayBuffer,   // The raw image bytes — pass to a Blob/URL to display it
    size: number,        // Image size in bytes
}
```

**Displaying album art in the browser:**

```javascript
const art = info.albumArt[0]
const blob = new Blob([art.data], { type: art.mimeType })
const url = URL.createObjectURL(blob)

const img = document.createElement('img')
img.src = url
document.body.appendChild(img)
```

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript to dist/
npm run build

# Run the tests once
npm test

# Run tests in watch mode (re-runs on file save)
npm run test:watch
```

## How it works (for the curious)

Audio files are binary formats — long sequences of bytes where each byte (or group of bytes) means something specific. `@pico-brief/audio-info` reads those bytes directly without decoding the audio itself:

- **MP3** — reads the ID3v2 tag at the front of the file to find chapters and album art; estimates duration from the Xing/VBRI header (for VBR files) or the bitrate (for CBR files).
- **FLAC** — reads metadata blocks that store the sample rate, total sample count, embedded pictures, and VorbisComment chapter tags.
- **OGG** — scans Ogg pages to parse VorbisComment / OpusTags headers for chapters and art, and reads the last granule position to calculate duration.
- **MP4 / M4A** — walks the box (atom) tree to find `mvhd` (duration), `chpl` (Nero chapters), and `covr` (cover art).
- **WAV** — reads the `fmt` and `data` chunks and divides the data size by the byte rate.

## License

MIT
