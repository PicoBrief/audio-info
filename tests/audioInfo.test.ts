import { describe, it, expect } from 'vitest'
import audioInfo from '../audioInfo'

// ─── Test helpers ─────────────────────────────────────────────────────────────

/** Build an ArrayBuffer from a plain array of byte values (0–255). */
function makeBuffer(arr: number[]): ArrayBuffer {
    const buf = new ArrayBuffer(arr.length)
    new Uint8Array(buf).set(arr)
    return buf
}

/**
 * Build a minimal valid WAV buffer.
 *
 * The buffer is only 45 bytes (just the RIFF/fmt/data headers).
 * The `logicalDataBytes` value is written into the "data" chunk size field so
 * the parser can calculate duration without needing the actual audio samples.
 *
 *   duration = logicalDataBytes / byteRate
 *   byteRate = sampleRate × channels × (bitsPerSample / 8)
 */
function makeWAV(
    sampleRate: number,
    channels: number,
    bitsPerSample: number,
    logicalDataBytes: number,
): ArrayBuffer {
    const byteRate = sampleRate * channels * (bitsPerSample / 8)
    // 44 standard header bytes + 1 extra so the parser's while-loop condition
    // (offset < byteLength - 8) is satisfied when reaching the data chunk.
    const buf = new ArrayBuffer(45)
    const v = new DataView(buf)

    // RIFF chunk header
    ;[0x52, 0x49, 0x46, 0x46].forEach((b, i) => v.setUint8(i, b))         // "RIFF"
    v.setUint32(4, 36 + logicalDataBytes, true)                             // file size - 8
    ;[0x57, 0x41, 0x56, 0x45].forEach((b, i) => v.setUint8(8 + i, b))    // "WAVE"

    // fmt sub-chunk
    ;[0x66, 0x6D, 0x74, 0x20].forEach((b, i) => v.setUint8(12 + i, b))   // "fmt "
    v.setUint32(16, 16, true)                                               // chunk size = 16
    v.setUint16(20, 1, true)                                                // audio format = PCM
    v.setUint16(22, channels, true)
    v.setUint32(24, sampleRate, true)
    v.setUint32(28, byteRate, true)
    v.setUint16(32, channels * (bitsPerSample / 8), true)                  // block align
    v.setUint16(34, bitsPerSample, true)

    // data sub-chunk header (no actual sample bytes written)
    ;[0x64, 0x61, 0x74, 0x61].forEach((b, i) => v.setUint8(36 + i, b))   // "data"
    v.setUint32(40, logicalDataBytes, true)

    return buf
}

/**
 * Build a minimal valid FLAC buffer containing only a STREAMINFO metadata block.
 *
 * The FLAC STREAMINFO encodes sample rate and total samples in a bit-packed
 * layout.  The parser reads them like this:
 *
 *   srHi        = uint16BE at (blockOffset + 10)          ← high 16 bits of 20-bit rate
 *   srLo        = (byte at blockOffset + 12) >> 4         ← low  4 bits
 *   sampleRate  = (srHi << 4) | srLo
 *
 *   totalSamplesHi = (byte at blockOffset + 13) & 0x0f   ← high 4 bits of 36-bit count
 *   totalSamplesLo = uint32BE at (blockOffset + 14)      ← low 32 bits
 *   totalSamples   = totalSamplesHi × 2³² + totalSamplesLo
 *
 *   duration = totalSamples / sampleRate
 */
function makeFLAC(sampleRate: number, totalSamples: number): ArrayBuffer {
    // 4 (fLaC) + 4 (block header) + 18 (minimum STREAMINFO content)
    const buf = new ArrayBuffer(26)
    const v = new DataView(buf)

    // "fLaC" marker
    ;[0x66, 0x4C, 0x61, 0x43].forEach((b, i) => v.setUint8(i, b))

    // Block header: isLast = 1 (bit 7), type = 0 STREAMINFO (bits 6-0), size = 18
    v.setUint8(4, 0x80) // isLast=1, blockType=STREAMINFO
    v.setUint8(5, 0x00)
    v.setUint8(6, 0x00)
    v.setUint8(7, 0x12) // 18 in hex

    // STREAMINFO content (bytes 8–25 in the file = bytes 0–17 relative to content start)
    // bytes  0– 9 (file  8–17): min/max block size, min/max frame size — all left as zero
    // bytes 10–11 (file 18–19): srHi = sampleRate >> 4
    const srHi = sampleRate >> 4
    v.setUint8(18, (srHi >> 8) & 0xff)
    v.setUint8(19, srHi & 0xff)
    // byte 12 (file 20) upper nibble: srLo = sampleRate & 0xf
    v.setUint8(20, (sampleRate & 0x0f) << 4)
    // byte 13 (file 21) lower nibble: totalSamplesHi (assume < 2³²  so = 0)
    v.setUint8(21, 0x00)
    // bytes 14–17 (file 22–25): totalSamplesLo (big-endian)
    v.setUint32(22, totalSamples >>> 0, false)

    return buf
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('audioInfo', () => {

    // ── Return shape ─────────────────────────────────────────────────────────
    describe('return shape', () => {
        it('always returns an object with duration, chapters, and albumArt', () => {
            const result = audioInfo(new ArrayBuffer(0))
            expect(result).toHaveProperty('duration')
            expect(result).toHaveProperty('chapters')
            expect(result).toHaveProperty('albumArt')
        })

        it('duration is always a number', () => {
            expect(typeof audioInfo(new ArrayBuffer(0)).duration).toBe('number')
        })

        it('chapters is always an array', () => {
            expect(Array.isArray(audioInfo(new ArrayBuffer(0)).chapters)).toBe(true)
        })

        it('albumArt is always an array', () => {
            expect(Array.isArray(audioInfo(new ArrayBuffer(0)).albumArt)).toBe(true)
        })
    })

    // ── Unknown / unrecognized format ────────────────────────────────────────
    describe('unknown format', () => {
        it('returns zero duration for an empty buffer', () => {
            expect(audioInfo(new ArrayBuffer(0)).duration).toBe(0)
        })

        it('returns zero duration for random bytes', () => {
            const result = audioInfo(makeBuffer([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]))
            expect(result.duration).toBe(0)
        })

        it('returns empty chapters and albumArt for an unrecognized buffer', () => {
            expect(audioInfo(makeBuffer([0x00, 0x01, 0x02, 0x03]))).toEqual({
                duration: 0,
                chapters: [],
                albumArt: [],
            })
        })
    })

    // ── WAV ──────────────────────────────────────────────────────────────────
    describe('WAV format', () => {
        it('calculates 1-second duration for 44100 Hz stereo 16-bit', () => {
            // byteRate = 44100 × 2 × 2 = 176400; 176400 bytes ÷ 176400 = 1.0 s
            const buf = makeWAV(44100, 2, 16, 176400)
            expect(audioInfo(buf).duration).toBeCloseTo(1.0, 2)
        })

        it('calculates 2-second duration for 8000 Hz mono 8-bit', () => {
            // byteRate = 8000 × 1 × 1 = 8000; 16000 bytes ÷ 8000 = 2.0 s
            const buf = makeWAV(8000, 1, 8, 16000)
            expect(audioInfo(buf).duration).toBeCloseTo(2.0, 2)
        })

        it('returns no chapters', () => {
            expect(audioInfo(makeWAV(44100, 1, 16, 44100 * 2)).chapters).toHaveLength(0)
        })

        it('returns no album art', () => {
            expect(audioInfo(makeWAV(44100, 1, 16, 44100 * 2)).albumArt).toHaveLength(0)
        })
    })

    // ── FLAC ─────────────────────────────────────────────────────────────────
    describe('FLAC format', () => {
        it('calculates 1-second duration from STREAMINFO (44100 Hz, 44100 samples)', () => {
            expect(audioInfo(makeFLAC(44100, 44100)).duration).toBeCloseTo(1.0, 2)
        })

        it('calculates 2-second duration (48000 Hz, 96000 samples)', () => {
            expect(audioInfo(makeFLAC(48000, 96000)).duration).toBeCloseTo(2.0, 2)
        })

        it('returns no chapters for a minimal FLAC', () => {
            expect(audioInfo(makeFLAC(44100, 44100)).chapters).toHaveLength(0)
        })

        it('returns no album art for a minimal FLAC', () => {
            expect(audioInfo(makeFLAC(44100, 44100)).albumArt).toHaveLength(0)
        })
    })

    // ── OGG ──────────────────────────────────────────────────────────────────
    describe('OGG format', () => {
        it('recognizes OGG signature and returns the right shape', () => {
            // Minimal OGG: "OggS" magic bytes, rest zeros
            const buf = new ArrayBuffer(55)
            const u8 = new Uint8Array(buf)
            u8[0] = 0x4f; u8[1] = 0x67; u8[2] = 0x67; u8[3] = 0x53 // "OggS"

            const result = audioInfo(buf)
            expect(result).toHaveProperty('duration')
            expect(Array.isArray(result.chapters)).toBe(true)
            expect(Array.isArray(result.albumArt)).toBe(true)
        })
    })

    // ── MP4 ──────────────────────────────────────────────────────────────────
    describe('MP4 format', () => {
        it('recognizes ftyp box signature and returns the right shape', () => {
            // 8-byte box: size=8 (big-endian) + "ftyp"
            const buf = makeBuffer([0x00, 0x00, 0x00, 0x08, 0x66, 0x74, 0x79, 0x70])
            const result = audioInfo(buf)
            expect(result).toHaveProperty('duration')
            expect(Array.isArray(result.chapters)).toBe(true)
            expect(Array.isArray(result.albumArt)).toBe(true)
        })

        it('recognizes moov box signature and returns the right shape', () => {
            // 8-byte box: size=8 (big-endian) + "moov"
            const buf = makeBuffer([0x00, 0x00, 0x00, 0x08, 0x6d, 0x6f, 0x6f, 0x76])
            const result = audioInfo(buf)
            expect(result).toHaveProperty('duration')
            expect(Array.isArray(result.chapters)).toBe(true)
            expect(Array.isArray(result.albumArt)).toBe(true)
        })
    })

    // ── MP3 format ───────────────────────────────────────────────────────────
    describe('MP3 format', () => {
        /**
         * Build a minimal MP3: a 10-byte ID3v2.3 header (no tag frames) followed
         * by one MPEG1 Layer III frame with a Xing VBR header inside it.
         *
         * Frame header bytes: [0xFF, 0xFB, 0x90, 0x00]
         *   0xFF 0xFB → sync word, MPEG1, Layer III, no CRC
         *   0x90      → bitrateIdx=9 → 128 kbps, srIdx=0 → 44100 Hz, no padding
         *   0x00      → channelMode=0 → stereo
         *
         * Derived values:
         *   samplesPerFrame = 1152 (MPEG1)
         *   sideInfoSize    = 32   (MPEG1, stereo)
         *   xingOffset      = frameOffset(10) + header(4) + sideInfo(32) = 46
         *
         * duration = totalFrames × 1152 / 44100
         */
        function makeMP3Xing(totalFrames: number): ArrayBuffer {
            // 10 (ID3 header) + 4 (frame header) + 32 (side info) + 12 (Xing) = 58 bytes
            const buf = new ArrayBuffer(58)
            const v = new DataView(buf)

            // ID3v2.3 header: "ID3", version=3, revision=0, flags=0, synchsafe size=0
            ;[0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]
                .forEach((b, i) => v.setUint8(i, b))

            // MPEG1 Layer III frame header at byte 10
            v.setUint8(10, 0xff)
            v.setUint8(11, 0xfb) // MPEG1, Layer III, no CRC
            v.setUint8(12, 0x90) // 128 kbps, 44100 Hz, no padding
            v.setUint8(13, 0x00) // stereo
            // bytes 14–45: side info (32 bytes), left as zero

            // Xing VBR header at byte 46
            ;[0x58, 0x69, 0x6e, 0x67].forEach((b, i) => v.setUint8(46 + i, b)) // "Xing"
            v.setUint32(50, 0x00000001, false) // flags: bit 0 = total-frames field present
            v.setUint32(54, totalFrames, false)

            return buf
        }

        /**
         * Build a bare CBR MP3: a valid MPEG1 Layer III frame header at byte 0,
         * no ID3 tag, no Xing/VBRI header.
         *
         * The parser falls back to: duration = (totalBytes × 8) / (128 × 1000)
         *
         * Buffer must be ≥ 62 bytes so the VBRI offset check runs and fails
         * cleanly (vbriOffset + 26 ≤ byteLength), proving the CBR path is taken.
         */
        function makeMP3CBR(totalBytes: number): ArrayBuffer {
            const buf = new ArrayBuffer(totalBytes)
            const v = new DataView(buf)
            v.setUint8(0, 0xff)
            v.setUint8(1, 0xfb) // MPEG1, Layer III
            v.setUint8(2, 0x90) // 128 kbps, 44100 Hz
            v.setUint8(3, 0x00) // stereo
            // rest is zeros — no Xing, no VBRI
            return buf
        }

        it('recognizes ID3v2 magic bytes as MP3 and returns the right shape', () => {
            // ID3 header with no audio frames → duration stays 0 but shape is correct
            const buf = makeBuffer([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00])
            const result = audioInfo(buf)
            expect(result).toHaveProperty('duration')
            expect(Array.isArray(result.chapters)).toBe(true)
            expect(Array.isArray(result.albumArt)).toBe(true)
        })

        it('calculates duration from a Xing VBR header (100 frames)', () => {
            const totalFrames = 100
            // duration = 100 × 1152 / 44100 ≈ 2.612 s
            const expected = (totalFrames * 1152) / 44100
            expect(audioInfo(makeMP3Xing(totalFrames)).duration).toBeCloseTo(expected, 3)
        })

        it('calculates duration from a Xing VBR header (500 frames)', () => {
            const totalFrames = 500
            // duration = 500 × 1152 / 44100 ≈ 13.061 s
            const expected = (totalFrames * 1152) / 44100
            expect(audioInfo(makeMP3Xing(totalFrames)).duration).toBeCloseTo(expected, 3)
        })

        it('estimates duration from CBR bitrate when no Xing or VBRI header is present', () => {
            // 128 kbps CBR: duration = (bytes × 8) / (128 × 1000)
            // Using 12800 bytes → 0.8 s
            const totalBytes = 12800
            const expected = (totalBytes * 8) / (128 * 1000)
            expect(audioInfo(makeMP3CBR(totalBytes)).duration).toBeCloseTo(expected, 3)
        })

        it('returns empty chapters and albumArt for a plain MP3 with no ID3 frames', () => {
            const result = audioInfo(makeMP3Xing(100))
            expect(result.chapters).toHaveLength(0)
            expect(result.albumArt).toHaveLength(0)
        })
    })
})
