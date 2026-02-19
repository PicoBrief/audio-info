/**
 * @pico-brief/audio-info: Extracts chapters, album art, and duration from audio files.
 * Supports: MP3, FLAC, OGG (Vorbis/Opus), MP4/M4A/AAC, WAV
 */

/* global type shims for environments without full DOM lib */
declare const TextDecoder: {
    new (label?: string): { decode(input?: ArrayBuffer | Uint8Array): string };
};
declare function atob(data: string): string;

// ─── Interfaces ──────────────────────────────────────────────────────────────

export interface ChapterInfo {
    id: number;
    startTime: number; // seconds
    endTime: number;   // seconds
    title?: string;
}

export interface AlbumArtInfo {
    type: string;
    mimeType: string;
    description: string;
    data: ArrayBuffer;
    size: number;
}

export interface AudioInfo {
    duration: number; // seconds
    chapters: ChapterInfo[];
    albumArt: AlbumArtInfo[];
}

// ─── Picture type labels (shared by ID3v2 APIC and FLAC PICTURE) ────────────

const PICTURE_TYPES = [
    'Other', '32x32 icon (PNG)', 'Other file icon',
    'Cover (front)', 'Cover (back)', 'Leaflet page', 'Media',
    'Lead artist', 'Artist', 'Conductor', 'Band/Orchestra',
    'Composer', 'Lyricist', 'Recording location', 'During recording',
    'During performance', 'Screen capture', 'A bright coloured fish',
    'Illustration', 'Band logotype', 'Publisher logotype',
];

// ─── Binary reading helpers ─────────────────────────────────────────────────

function readAscii(view: DataView, offset: number, length: number): string {
    let s = '';
    for (let i = 0; i < length; i++) {
        const c = view.getUint8(offset + i);
        if (c === 0) break;
        s += String.fromCharCode(c);
    }
    return s;
}

function readNullTerminated(view: DataView, offset: number): string {
    let s = '';
    while (offset < view.byteLength) {
        const c = view.getUint8(offset++);
        if (c === 0) break;
        s += String.fromCharCode(c);
    }
    return s;
}

function readSynchsafe(view: DataView, offset: number): number {
    return (
        ((view.getUint8(offset) & 0x7f) << 21) |
        ((view.getUint8(offset + 1) & 0x7f) << 14) |
        ((view.getUint8(offset + 2) & 0x7f) << 7) |
        (view.getUint8(offset + 3) & 0x7f)
    );
}

function readUint24BE(view: DataView, offset: number): number {
    return (view.getUint8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2);
}

/** Read a 64-bit big-endian unsigned integer (clamped to Number precision). */
function readUint64BE(view: DataView, offset: number): number {
    const hi = view.getUint32(offset, false);
    const lo = view.getUint32(offset + 4, false);
    return hi * 0x1_0000_0000 + lo;
}

/** Read a 64-bit little-endian signed integer (clamped to Number precision). */
function readInt64LE(view: DataView, offset: number): number {
    const lo = view.getUint32(offset, true);
    const hi = view.getInt32(offset + 4, true);
    return hi * 0x1_0000_0000 + lo;
}

function decodeString(view: DataView, offset: number, length: number, encoding: number): string {
    try {
        const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
        const charset =
            encoding === 0 ? 'iso-8859-1' :
                encoding === 1 ? 'utf-16' :
                    encoding === 2 ? 'utf-16be' :
                        'utf-8';
        return new TextDecoder(charset).decode(bytes).replace(/\0+$/, '');
    } catch {
        return readAscii(view, offset, length);
    }
}

function sliceBuffer(view: DataView, offset: number, length: number): ArrayBuffer {
    return view.buffer.slice(view.byteOffset + offset, view.byteOffset + offset + length) as ArrayBuffer;
}

// ─── Format detection ───────────────────────────────────────────────────────

type AudioFormat = 'mp3' | 'flac' | 'ogg' | 'mp4' | 'wav' | 'unknown';

function detectFormat(view: DataView): AudioFormat {
    const len = view.byteLength;

    // ID3v2 header → MP3
    if (len >= 3 && view.getUint8(0) === 0x49 && view.getUint8(1) === 0x44 && view.getUint8(2) === 0x33) return 'mp3';

    // fLaC
    if (len >= 4 && readAscii(view, 0, 4) === 'fLaC') return 'flac';

    // OggS
    if (len >= 4 && readAscii(view, 0, 4) === 'OggS') return 'ogg';

    // RIFF…WAVE
    if (len >= 12 && readAscii(view, 0, 4) === 'RIFF' && readAscii(view, 8, 4) === 'WAVE') return 'wav';

    // MP4 ftyp / moov
    if (len >= 8) {
        const box = readAscii(view, 4, 4);
        if (box === 'ftyp' || box === 'moov') return 'mp4';
    }

    // Bare MP3 sync word scan
    if (len >= 4) {
        for (let i = 0; i < Math.min(len - 2, 8192); i++) {
            if (view.getUint8(i) === 0xff && (view.getUint8(i + 1) & 0xe0) === 0xe0) return 'mp3';
        }
    }

    return 'unknown';
}

// ─── VorbisComment parser (shared by FLAC and OGG) ─────────────────────────

interface VorbisComments {
    vendor: string;
    comments: Record<string, string[]>;
}

function parseVorbisComment(view: DataView, offset: number, length: number): VorbisComments {
    const end = offset + length;
    const result: VorbisComments = { vendor: '', comments: {} };

    if (offset + 4 > end) return result;
    const vendorLen = view.getUint32(offset, true);
    offset += 4;
    if (offset + vendorLen > end) return result;
    result.vendor = decodeString(view, offset, vendorLen, 3);
    offset += vendorLen;

    if (offset + 4 > end) return result;
    const count = view.getUint32(offset, true);
    offset += 4;

    for (let i = 0; i < count && offset + 4 <= end; i++) {
        const len = view.getUint32(offset, true);
        offset += 4;
        if (offset + len > end) break;
        const entry = decodeString(view, offset, len, 3);
        offset += len;
        const eq = entry.indexOf('=');
        if (eq > 0) {
            const key = entry.substring(0, eq).toUpperCase();
            const val = entry.substring(eq + 1);
            if (!result.comments[key]) result.comments[key] = [];
            result.comments[key].push(val);
        }
    }

    return result;
}

/** Extract chapters from VorbisComment CHAPTER tags. */
function chaptersFromVorbisComments(vc: VorbisComments): ChapterInfo[] {
    const chapters: ChapterInfo[] = [];
    // Look for CHAPTERxxx=HH:MM:SS.mmm and CHAPTERxxxNAME=...
    const timeEntries: { idx: number; time: number }[] = [];
    const nameEntries: Record<number, string> = {};

    for (const [key, vals] of Object.entries(vc.comments)) {
        const timeMatch = key.match(/^CHAPTER(\d{3})$/);
        if (timeMatch) {
            const idx = parseInt(timeMatch[1], 10);
            const t = parseTimestamp(vals[0]);
            if (t !== null) timeEntries.push({ idx, time: t });
        }
        const nameMatch = key.match(/^CHAPTER(\d{3})NAME$/);
        if (nameMatch) {
            nameEntries[parseInt(nameMatch[1], 10)] = vals[0];
        }
    }

    timeEntries.sort((a, b) => a.idx - b.idx);

    for (let i = 0; i < timeEntries.length; i++) {
        const { idx, time } = timeEntries[i];
        const endTime = i + 1 < timeEntries.length ? timeEntries[i + 1].time : -1; // unknown
        chapters.push({
            id: i,
            startTime: time,
            endTime,
            title: nameEntries[idx],
        });
    }

    return chapters;
}

/** Parse HH:MM:SS.mmm → seconds */
function parseTimestamp(s: string): number | null {
    if (!s) return null;
    const m = s.match(/^(\d+):(\d+):(\d+)(?:\.(\d+))?$/);
    if (!m) return null;
    return parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10) + (m[4] ? parseInt(m[4], 10) / Math.pow(10, m[4].length) : 0);
}

/** Decode a FLAC-style PICTURE block and return AlbumArtInfo. */
function parseFLACPictureBlock(view: DataView, offset: number, length: number): AlbumArtInfo | null {
    const end = offset + length;
    if (offset + 4 > end) return null;

    const pictureType = view.getUint32(offset, false);
    offset += 4;

    if (offset + 4 > end) return null;
    const mimeLen = view.getUint32(offset, false);
    offset += 4;
    if (offset + mimeLen > end) return null;
    const mimeType = readAscii(view, offset, mimeLen);
    offset += mimeLen;

    if (offset + 4 > end) return null;
    const descLen = view.getUint32(offset, false);
    offset += 4;
    if (offset + descLen > end) return null;
    const description = decodeString(view, offset, descLen, 3);
    offset += descLen;

    // width(4) + height(4) + colorDepth(4) + numColors(4)
    offset += 16;
    if (offset + 4 > end) return null;

    const dataLen = view.getUint32(offset, false);
    offset += 4;
    if (offset + dataLen > end) return null;

    return {
        type: PICTURE_TYPES[pictureType] || 'Unknown',
        mimeType,
        description,
        data: sliceBuffer(view, offset, dataLen),
        size: dataLen,
    };
}

// ─── MP3 parser ─────────────────────────────────────────────────────────────

const MP3_BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const MP3_BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const MP3_SAMPLE_RATES_V1 = [44100, 48000, 32000];
const MP3_SAMPLE_RATES_V2 = [22050, 24000, 16000];
const MP3_SAMPLE_RATES_V25 = [11025, 12000, 8000];

interface MP3FrameInfo {
    offset: number;
    mpegVersion: number; // 1, 2, or 2.5
    layer: number;
    bitrate: number;     // kbps
    sampleRate: number;
    channels: number;
    samplesPerFrame: number;
    frameSize: number;
    sideInfoSize: number;
}

function findMP3Frame(view: DataView, start: number): MP3FrameInfo | null {
    for (let i = start; i < Math.min(view.byteLength - 4, start + 16384); i++) {
        if (view.getUint8(i) !== 0xff || (view.getUint8(i + 1) & 0xe0) !== 0xe0) continue;

        const b1 = view.getUint8(i + 1);
        const b2 = view.getUint8(i + 2);
        const b3 = view.getUint8(i + 3);

        const versionBits = (b1 >> 3) & 0x03;
        const layerBits = (b1 >> 1) & 0x03;
        const bitrateIdx = (b2 >> 4) & 0x0f;
        const srIdx = (b2 >> 2) & 0x03;
        const padding = (b2 >> 1) & 0x01;
        const channelMode = (b3 >> 6) & 0x03;

        if (versionBits === 1 || layerBits === 0 || bitrateIdx === 0 || bitrateIdx === 15 || srIdx === 3) continue;

        const mpegVersion = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5;
        const layer = layerBits === 3 ? 1 : layerBits === 2 ? 2 : 3;

        if (layer !== 3 && layer !== 2 && layer !== 1) continue;

        let bitrate: number;
        if (mpegVersion === 1 && layer === 3) bitrate = MP3_BITRATES_V1_L3[bitrateIdx];
        else if (mpegVersion !== 1 && layer === 3) bitrate = MP3_BITRATES_V2_L3[bitrateIdx];
        else continue; // Simplified: only handle Layer III fully

        const sampleRates = mpegVersion === 1 ? MP3_SAMPLE_RATES_V1 : mpegVersion === 2 ? MP3_SAMPLE_RATES_V2 : MP3_SAMPLE_RATES_V25;
        const sampleRate = sampleRates[srIdx];
        const samplesPerFrame = mpegVersion === 1 ? 1152 : 576;
        const frameSize = Math.floor((samplesPerFrame / 8) * (bitrate * 1000) / sampleRate) + padding;

        if (frameSize < 1) continue;

        const channels = channelMode === 3 ? 1 : 2;
        const sideInfoSize = mpegVersion === 1 ? (channels === 1 ? 17 : 32) : (channels === 1 ? 9 : 17);

        return { offset: i, mpegVersion, layer, bitrate, sampleRate, channels, samplesPerFrame, frameSize, sideInfoSize };
    }
    return null;
}

function parseMP3(view: DataView): AudioInfo {
    const info: AudioInfo = { duration: 0, chapters: [], albumArt: [] };

    let audioDataStart = 0;
    let id3Size = 0;

    // ── ID3v2 tag ──
    if (view.byteLength >= 10 && view.getUint8(0) === 0x49 && view.getUint8(1) === 0x44 && view.getUint8(2) === 0x33) {
        const version = view.getUint8(3);
        const flags = view.getUint8(5);
        id3Size = readSynchsafe(view, 6);
        const hasFooter = (flags & 0x10) !== 0;
        const totalTagSize = 10 + id3Size + (hasFooter ? 10 : 0);
        audioDataStart = totalTagSize;

        if (version >= 3 && version <= 4) {
            parseID3v2Frames(view, 10, id3Size, version, info);
        }
    }

    // ── Duration from Xing/VBRI or CBR estimate ──
    const frame = findMP3Frame(view, audioDataStart);
    if (frame) {
        const xingOffset = frame.offset + 4 + frame.sideInfoSize;
        const xingTag = readAscii(view, xingOffset, 4);

        if (xingTag === 'Xing' || xingTag === 'Info') {
            const xingFlags = view.getUint32(xingOffset + 4, false);
            if (xingFlags & 0x01) { // frames field present
                const totalFrames = view.getUint32(xingOffset + 8, false);
                info.duration = (totalFrames * frame.samplesPerFrame) / frame.sampleRate;
            }
        } else {
            // Check VBRI header (always at offset 36 from frame start)
            const vbriOffset = frame.offset + 36;
            if (vbriOffset + 26 <= view.byteLength && readAscii(view, vbriOffset, 4) === 'VBRI') {
                const totalFrames = view.getUint32(vbriOffset + 14, false);
                info.duration = (totalFrames * frame.samplesPerFrame) / frame.sampleRate;
            } else {
                // CBR estimate
                const audioBytes = view.byteLength - audioDataStart;
                if (frame.bitrate > 0) {
                    info.duration = (audioBytes * 8) / (frame.bitrate * 1000);
                }
            }
        }
    }

    return info;
}

function parseID3v2Frames(view: DataView, start: number, size: number, version: number, info: AudioInfo): void {
    let offset = start;
    const end = start + size;

    while (offset < end - 10) {
        const frameId = readAscii(view, offset, 4);
        if (!/^[A-Z0-9]{4}$/.test(frameId)) break;

        const frameSize = version === 4 ? readSynchsafe(view, offset + 4) : view.getUint32(offset + 4, false);
        offset += 10;

        if (frameSize <= 0 || offset + frameSize > end) break;

        if (frameId === 'CHAP') {
            const ch = parseID3ChapterFrame(view, offset, frameSize, version);
            if (ch) {
                ch.id = info.chapters.length;
                info.chapters.push(ch);
            }
        } else if (frameId === 'APIC') {
            const art = parseID3APICFrame(view, offset, frameSize);
            if (art) info.albumArt.push(art);
        }

        offset += frameSize;
    }
}

function parseID3ChapterFrame(view: DataView, offset: number, size: number, version: number): ChapterInfo | null {
    let cur = offset;
    const end = offset + size;

    // Element ID (null-terminated)
    const elemId = readNullTerminated(view, cur);
    cur += elemId.length + 1;
    if (cur + 16 > end) return null;

    const startMs = view.getUint32(cur, false); cur += 4;
    const endMs = view.getUint32(cur, false);   cur += 4;
    cur += 8; // start/end byte offsets (skip)

    const chapter: ChapterInfo = { id: 0, startTime: startMs / 1000, endTime: endMs / 1000 };

    // Parse embedded sub-frames for title
    while (cur < end - 10) {
        const subId = readAscii(view, cur, 4);
        if (!/^[A-Z0-9]{4}$/.test(subId)) break;
        const subSize = version === 4 ? readSynchsafe(view, cur + 4) : view.getUint32(cur + 4, false);
        cur += 10;
        if (subSize <= 0 || cur + subSize > end) break;

        if (subId === 'TIT2') {
            const enc = view.getUint8(cur);
            chapter.title = decodeString(view, cur + 1, subSize - 1, enc);
        }
        cur += subSize;
    }

    return chapter;
}

function parseID3APICFrame(view: DataView, offset: number, size: number): AlbumArtInfo | null {
    let cur = offset;
    const end = offset + size;

    const encoding = view.getUint8(cur); cur += 1;
    const mimeType = readNullTerminated(view, cur);
    cur += mimeType.length + 1;
    if (cur >= end) return null;

    const pictureType = view.getUint8(cur); cur += 1;

    // Description (encoding-dependent null terminator)
    if (encoding === 1 || encoding === 2) {
        // UTF-16: scan for double null
        while (cur + 1 < end) {
            if (view.getUint8(cur) === 0 && view.getUint8(cur + 1) === 0) { cur += 2; break; }
            cur += 2;
        }
    } else {
        // ISO-8859-1 or UTF-8: single null
        while (cur < end && view.getUint8(cur) !== 0) cur++;
        cur++; // skip null
    }

    const imgLen = end - cur;
    if (imgLen <= 0) return null;

    return {
        type: PICTURE_TYPES[pictureType] || 'Unknown',
        mimeType,
        description: '',
        data: sliceBuffer(view, cur, imgLen),
        size: imgLen,
    };
}

// ─── FLAC parser ────────────────────────────────────────────────────────────

function parseFLAC(view: DataView): AudioInfo {
    const info: AudioInfo = { duration: 0, chapters: [], albumArt: [] };
    if (view.byteLength < 8 || readAscii(view, 0, 4) !== 'fLaC') return info;

    let offset = 4;

    while (offset < view.byteLength - 4) {
        const blockHeader = view.getUint8(offset);
        const isLast = (blockHeader & 0x80) !== 0;
        const blockType = blockHeader & 0x7f;
        const blockSize = readUint24BE(view, offset + 1);
        offset += 4;

        if (offset + blockSize > view.byteLength) break;

        if (blockType === 0) {
            // STREAMINFO
            // Bytes 0-9: block sizes + frame sizes (skip)
            // Byte 10-12 (upper 20 bits): sample rate
            // Bit 10*8=80 to 99: sample rate is 20 bits starting at byte 10
            if (blockSize >= 18) {
                const srHi = view.getUint16(offset + 10, false); // bits [0..15]
                const srLo = (view.getUint8(offset + 12) >> 4) & 0x0f; // bits [16..19]
                const sampleRate = (srHi << 4) | srLo;

                // Total samples: 36 bits starting at bit 4 of byte 13
                const totalSamplesHi = view.getUint8(offset + 13) & 0x0f;
                const totalSamplesLo = view.getUint32(offset + 14, false);
                const totalSamples = totalSamplesHi * 0x1_0000_0000 + totalSamplesLo;

                if (sampleRate > 0) {
                    info.duration = totalSamples / sampleRate;
                }
            }
        } else if (blockType === 4) {
            // VORBIS_COMMENT
            const vc = parseVorbisComment(view, offset, blockSize);
            info.chapters = chaptersFromVorbisComments(vc);
        } else if (blockType === 6) {
            // PICTURE
            const art = parseFLACPictureBlock(view, offset, blockSize);
            if (art) info.albumArt.push(art);
        }

        offset += blockSize;
        if (isLast) break;
    }

    // Patch chapter end times using duration
    patchChapterEndTimes(info);

    return info;
}

// ─── OGG parser ─────────────────────────────────────────────────────────────

interface OggPage {
    headerType: number;
    granulePosition: number;
    serialNumber: number;
    pageSequence: number;
    segmentCount: number;
    dataOffset: number;
    dataLength: number;
    totalSize: number;
}

function readOggPage(view: DataView, offset: number): OggPage | null {
    if (offset + 27 > view.byteLength) return null;
    if (readAscii(view, offset, 4) !== 'OggS') return null;

    const headerType = view.getUint8(offset + 5);
    const granulePosition = readInt64LE(view, offset + 6);
    const serialNumber = view.getUint32(offset + 14, true);
    const pageSequence = view.getUint32(offset + 18, true);
    const segmentCount = view.getUint8(offset + 26);

    if (offset + 27 + segmentCount > view.byteLength) return null;

    let dataLength = 0;
    for (let i = 0; i < segmentCount; i++) {
        dataLength += view.getUint8(offset + 27 + i);
    }

    const dataOffset = offset + 27 + segmentCount;
    const totalSize = 27 + segmentCount + dataLength;

    return { headerType, granulePosition, serialNumber, pageSequence, segmentCount, dataOffset, dataLength, totalSize };
}

/** Collect the full packet data from an OGG page (handles multi-segment packets). */
function getPageData(view: DataView, page: OggPage): Uint8Array {
    return new Uint8Array(view.buffer, view.byteOffset + page.dataOffset, page.dataLength);
}

function parseOGG(view: DataView): AudioInfo {
    const info: AudioInfo = { duration: 0, chapters: [], albumArt: [] };
    if (view.byteLength < 4 || readAscii(view, 0, 4) !== 'OggS') return info;

    let sampleRate = 0;
    let isOpus = false;
    let preSkip = 0;

    // ── First pass: parse identification and comment headers ──
    let offset = 0;
    let headerPagesParsed = 0;
    // We need the first 2 pages (identification + comment) from the first logical stream.
    let firstSerial: number | null = null;

    // Accumulate data across continuation pages for the comment header
    let commentData: Uint8Array | null = null;
    let collectingComment = false;

    while (offset < view.byteLength && headerPagesParsed < 2) {
        const page = readOggPage(view, offset);
        if (!page) break;

        if (firstSerial === null) firstSerial = page.serialNumber;

        if (page.serialNumber === firstSerial) {
            const data = getPageData(view, page);

            if (headerPagesParsed === 0 && !(page.headerType & 0x01)) {
                // First page - identification header
                if (data.length >= 7 && readAscii(new DataView(data.buffer, data.byteOffset), 0, 7) === '\x01vorbis') {
                    // Vorbis identification
                    const dv = new DataView(data.buffer, data.byteOffset);
                    sampleRate = dv.getUint32(12, true); // channels at 11, sampleRate at 12-15
                    headerPagesParsed = 1;
                } else if (data.length >= 8 && readAscii(new DataView(data.buffer, data.byteOffset), 0, 8) === 'OpusHead') {
                    isOpus = true;
                    const dv = new DataView(data.buffer, data.byteOffset);
                    sampleRate = 48000; // Opus always uses 48 kHz for granule
                    preSkip = dv.getUint16(10, true);
                    headerPagesParsed = 1;
                }
            } else if (headerPagesParsed === 1) {
                // Second logical page(s) - comment header
                if (collectingComment && commentData) {
                    // Continuation page
                    const merged: Uint8Array = new Uint8Array(commentData.length + data.length);
                    merged.set(commentData);
                    merged.set(data, commentData.length);
                    commentData = merged;
                } else {
                    // Check for Vorbis comment or OpusTags header
                    let commentStart = 0;
                    const dv = new DataView(data.buffer, data.byteOffset);
                    if (!isOpus && data.length >= 7 && readAscii(dv, 0, 7) === '\x03vorbis') {
                        commentStart = 7;
                    } else if (isOpus && data.length >= 8 && readAscii(dv, 0, 8) === 'OpusTags') {
                        commentStart = 8;
                    }

                    if (commentStart > 0) {
                        commentData = data.slice(commentStart);
                        collectingComment = true;
                    }
                }

                // Check if packet is complete (last segment < 255)
                const lastSegSize = view.getUint8(offset + 26 + page.segmentCount);
                // Actually check the last segment in the segment table
                const lastSeg = view.getUint8(offset + 27 + page.segmentCount - 1);
                if (lastSeg < 255 && commentData) {
                    // Packet complete
                    const commentView = new DataView(commentData.buffer, commentData.byteOffset, commentData.length);
                    const vc = parseVorbisComment(commentView, 0, commentData.length);
                    info.chapters = chaptersFromVorbisComments(vc);

                    // Album art via METADATA_BLOCK_PICTURE
                    const pictures = vc.comments['METADATA_BLOCK_PICTURE'];
                    if (pictures) {
                        for (const b64 of pictures) {
                            const art = decodeMetadataBlockPicture(b64);
                            if (art) info.albumArt.push(art);
                        }
                    }

                    headerPagesParsed = 2;
                    collectingComment = false;
                }
            }
        }

        offset += page.totalSize;
    }

    // ── Duration: find the last OGG page for this stream and read granule ──
    if (sampleRate > 0 && firstSerial !== null) {
        // Scan backwards from end to find last OggS page
        const searchStart = Math.max(0, view.byteLength - 65536);
        let lastGranule = -1;

        let scanOffset = searchStart;
        while (scanOffset < view.byteLength - 4) {
            // Look for OggS
            if (view.getUint8(scanOffset) === 0x4f && view.getUint8(scanOffset + 1) === 0x67 &&
                view.getUint8(scanOffset + 2) === 0x67 && view.getUint8(scanOffset + 3) === 0x53) {
                const page = readOggPage(view, scanOffset);
                if (page && page.serialNumber === firstSerial && page.granulePosition >= 0) {
                    lastGranule = page.granulePosition;
                }
                if (page) {
                    scanOffset += page.totalSize;
                    continue;
                }
            }
            scanOffset++;
        }

        if (lastGranule > 0) {
            if (isOpus) {
                info.duration = Math.max(0, (lastGranule - preSkip) / sampleRate);
            } else {
                info.duration = lastGranule / sampleRate;
            }
        }
    }

    patchChapterEndTimes(info);
    return info;
}

/** Decode a base64-encoded METADATA_BLOCK_PICTURE into AlbumArtInfo */
function decodeMetadataBlockPicture(b64: string): AlbumArtInfo | null {
    try {
        const binaryStr = atob(b64);
        const bytes = new Uint8Array(binaryStr.length);
        for (let i = 0; i < binaryStr.length; i++) bytes[i] = binaryStr.charCodeAt(i);
        const dv = new DataView(bytes.buffer);
        return parseFLACPictureBlock(dv, 0, bytes.length);
    } catch {
        return null;
    }
}

// ─── MP4/M4A parser ─────────────────────────────────────────────────────────

function parseMP4(view: DataView): AudioInfo {
    const info: AudioInfo = { duration: 0, chapters: [], albumArt: [] };

    // We need to traverse the box tree
    parseMP4Boxes(view, 0, view.byteLength, info, []);
    patchChapterEndTimes(info);
    return info;
}

function parseMP4Boxes(view: DataView, start: number, end: number, info: AudioInfo, path: string[]): void {
    let offset = start;

    while (offset < end - 8) {
        let boxSize = view.getUint32(offset, false);
        const boxType = readAscii(view, offset + 4, 4);
        let headerSize = 8;

        if (boxSize === 1 && offset + 16 <= end) {
            // 64-bit extended size
            boxSize = readUint64BE(view, offset + 8);
            headerSize = 16;
        } else if (boxSize === 0) {
            // Box extends to end of file
            boxSize = end - offset;
        }

        if (boxSize < headerSize || offset + boxSize > end) break;

        const contentStart = offset + headerSize;
        const contentEnd = offset + boxSize;
        const currentPath = [...path, boxType];

        // Duration from mvhd
        if (boxType === 'mvhd') {
            parseMvhd(view, contentStart, contentEnd, info);
        }

        // Nero chapters from chpl
        if (boxType === 'chpl') {
            parseChpl(view, contentStart, contentEnd, info);
        }

        // Album art from covr data atom
        if (boxType === 'covr') {
            parseCovr(view, contentStart, contentEnd, info);
        }

        // Container boxes: recurse into them
        const containers = new Set([
            'moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'meta', 'ilst', 'covr',
        ]);
        if (containers.has(boxType)) {
            let childStart = contentStart;
            // 'meta' has a 4-byte version/flags field before children
            if (boxType === 'meta' && contentStart + 4 <= contentEnd) {
                childStart = contentStart + 4;
            }
            parseMP4Boxes(view, childStart, contentEnd, info, currentPath);
        }

        offset += boxSize;
    }
}

function parseMvhd(view: DataView, start: number, end: number, info: AudioInfo): void {
    if (start + 4 > end) return;
    const version = view.getUint8(start);

    let timescale: number;
    let duration: number;

    if (version === 0) {
        if (start + 20 > end) return;
        timescale = view.getUint32(start + 12, false);
        duration = view.getUint32(start + 16, false);
    } else {
        if (start + 28 > end) return;
        timescale = view.getUint32(start + 20, false);
        duration = readUint64BE(view, start + 24);
    }

    if (timescale > 0) {
        info.duration = duration / timescale;
    }
}

function parseChpl(view: DataView, start: number, end: number, info: AudioInfo): void {
    // Nero chapter format
    let offset = start;
    if (offset + 5 > end) return;

    // version (4 bytes) + unknown (1 byte)
    offset += 5;

    if (offset + 4 > end) return;
    const count = view.getUint32(offset, false);
    offset += 4;

    for (let i = 0; i < count && offset + 9 <= end; i++) {
        // Start time in 100-nanosecond units (8 bytes BE)
        const timestamp100ns = readUint64BE(view, offset);
        offset += 8;

        const titleLen = view.getUint8(offset);
        offset += 1;

        if (offset + titleLen > end) break;
        const title = decodeString(view, offset, titleLen, 3);
        offset += titleLen;

        info.chapters.push({
            id: i,
            startTime: timestamp100ns / 10_000_000,
            endTime: -1, // will be patched
            title,
        });
    }
}

function parseCovr(view: DataView, start: number, end: number, info: AudioInfo): void {
    // covr contains 'data' atom(s)
    let offset = start;

    while (offset < end - 8) {
        const boxSize = view.getUint32(offset, false);
        const boxType = readAscii(view, offset + 4, 4);

        if (boxSize < 8 || offset + boxSize > end) break;

        if (boxType === 'data') {
            // data atom: 4 bytes type indicator + 4 bytes locale, then image data
            const dataStart = offset + 16; // 8 (box header) + 4 (type) + 4 (locale)
            const dataLen = boxSize - 16;

            if (dataLen > 0 && dataStart + dataLen <= end) {
                const typeIndicator = view.getUint32(offset + 8, false);
                let mimeType = 'image/jpeg';
                if (typeIndicator === 14) mimeType = 'image/png';

                info.albumArt.push({
                    type: 'Cover (front)',
                    mimeType,
                    description: '',
                    data: sliceBuffer(view, dataStart, dataLen),
                    size: dataLen,
                });
            }
        }

        offset += boxSize;
    }
}

// ─── WAV parser (duration only) ─────────────────────────────────────────────

function parseWAV(view: DataView): AudioInfo {
    const info: AudioInfo = { duration: 0, chapters: [], albumArt: [] };
    if (view.byteLength < 44 || readAscii(view, 0, 4) !== 'RIFF' || readAscii(view, 8, 4) !== 'WAVE') return info;

    let offset = 12;
    let sampleRate = 0;
    let byteRate = 0;
    let bitsPerSample = 0;
    let channels = 0;

    while (offset < view.byteLength - 8) {
        const chunkId = readAscii(view, offset, 4);
        const chunkSize = view.getUint32(offset + 4, true); // LE
        offset += 8;

        if (chunkId === 'fmt ') {
            if (chunkSize >= 16) {
                channels = view.getUint16(offset + 2, true);
                sampleRate = view.getUint32(offset + 4, true);
                byteRate = view.getUint32(offset + 8, true);
                bitsPerSample = view.getUint16(offset + 14, true);
            }
        } else if (chunkId === 'data') {
            if (byteRate > 0) {
                info.duration = chunkSize / byteRate;
            } else if (sampleRate > 0 && channels > 0 && bitsPerSample > 0) {
                info.duration = chunkSize / (sampleRate * channels * (bitsPerSample / 8));
            }
            break; // data chunk is typically last meaningful chunk
        }

        offset += chunkSize;
        // Chunks are word-aligned
        if (chunkSize % 2 !== 0) offset++;
    }

    return info;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Patch -1 endTime values: use next chapter's startTime or total duration. */
function patchChapterEndTimes(info: AudioInfo): void {
    for (let i = 0; i < info.chapters.length; i++) {
        if (info.chapters[i].endTime < 0) {
            info.chapters[i].endTime = i + 1 < info.chapters.length
                ? info.chapters[i + 1].startTime
                : info.duration;
        }
    }
}

// ─── Main entry point ───────────────────────────────────────────────────────

/**
 * Extract audio metadata (duration, chapters, album art) from an ArrayBuffer.
 * Supports MP3, FLAC, OGG (Vorbis/Opus), MP4/M4A/AAC, and WAV.
 */
export default function audioInfo(buffer: ArrayBuffer): AudioInfo {
    const view = new DataView(buffer);
    const format = detectFormat(view);

    switch (format) {
        case 'mp3':  return parseMP3(view);
        case 'flac': return parseFLAC(view);
        case 'ogg':  return parseOGG(view);
        case 'mp4':  return parseMP4(view);
        case 'wav':  return parseWAV(view);
        default:     return { duration: 0, chapters: [], albumArt: [] };
    }
}
