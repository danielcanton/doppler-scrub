// Container check before anything parses a file.
//
// Reads the container header (MP4/MOV boxes, Matroska/WebM elements, WAV
// chunks) and accepts only common codecs, so an odd or disguised file is
// refused early with a clear message instead of reaching a decoder.
//
// inspectMedia(bytes) -> { fmt, adec, video, hevc, webm } or throws Error(message for the user).

const SUPPORTED = 'Use MP4, MOV, M4A, WebM, MKV or WAV.';

const MOV_AUDIO = { mp4a: 'aac', Opus: 'opus', alac: 'alac', fLaC: 'flac', '.mp3': 'mp3float',
  lpcm: '', sowt: '', twos: '', in24: '', in32: '', fl32: '', fl64: '', raw: '' };
const MOV_VIDEO = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'vp09', 'av01']);
const MKV_AUDIO = { A_AAC: 'aac', A_OPUS: 'opus', A_VORBIS: 'vorbis', A_FLAC: 'flac', 'A_MPEG/L3': 'mp3float' };
const MKV_VIDEO = new Set(['V_VP8', 'V_VP9', 'V_AV1', 'V_MPEG4/ISO/AVC', 'V_MPEGH/ISO/HEVC']);
const WEBM_VIDEO = new Set(['V_VP8', 'V_VP9', 'V_AV1']);

const ascii = (b, p, n) => String.fromCharCode(...b.subarray(p, p + n));
const u32 = (b, p) => ((b[p] << 24) >>> 0) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3];

function inspectMedia(b) {
  if (b.length < 16) throw new Error(`This file is too small to be a video. ${SUPPORTED}`);
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WAVE') return wav(b);
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return matroska(b);
  if (['ftyp', 'moov', 'mdat', 'wide', 'free', 'skip'].includes(ascii(b, 4, 4))) return mov(b);
  throw new Error(`This file type isn't supported. ${SUPPORTED}`);
}

// ------------------------------------------------------------- MP4 / MOV --
function eachBox(b, start, end, fn) {
  let p = start;
  while (p + 8 <= end) {
    let size = u32(b, p), hdr = 8;
    const type = ascii(b, p + 4, 4);
    if (size === 1) { size = u32(b, p + 8) * 2 ** 32 + u32(b, p + 12); hdr = 16; }
    else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    if (fn(type, p + hdr, p + size) === false) return;
    p += size;
  }
}
const child = (b, start, end, want) => { let r = null; eachBox(b, start, end, (t, s, e) => { if (t === want) { r = [s, e]; return false; } }); return r; };

function mov(b) {
  const moov = child(b, 0, b.length, 'moov');
  if (!moov) throw new Error("This MP4 has no track list (it may be cut short). Try exporting it again.");
  const tracks = [];
  eachBox(b, moov[0], moov[1], (t, s, e) => {
    if (t !== 'trak') return;
    const mdia = child(b, s, e, 'mdia'); if (!mdia) return;
    const hdlr = child(b, mdia[0], mdia[1], 'hdlr');
    const handler = hdlr ? ascii(b, hdlr[0] + 8, 4) : '';
    const minf = child(b, mdia[0], mdia[1], 'minf');
    const stbl = minf && child(b, minf[0], minf[1], 'stbl');
    const stsd = stbl && child(b, stbl[0], stbl[1], 'stsd');
    const entry = stsd && stsd[0] + 16 <= stsd[1] ? ascii(b, stsd[0] + 12, 4) : '';
    tracks.push({ handler, entry });
  });
  const audio = tracks.filter((t) => t.handler === 'soun');
  const video = tracks.filter((t) => t.handler === 'vide');
  if (!audio.length) throw new Error('This file has no audio track, so there is nothing to clean.');
  const badA = audio.find((t) => !(t.entry in MOV_AUDIO));
  if (badA) throw new Error(`The audio in this file uses a codec we don't open ("${badA.entry.trim()}"). Export it as AAC and try again.`);
  const badV = video.find((t) => !MOV_VIDEO.has(t.entry));
  if (badV) throw new Error(`The video in this file uses a codec we don't open ("${badV.entry.trim()}"). Export it as H.264 or HEVC and try again.`);
  const decs = [...new Set(audio.map((t) => MOV_AUDIO[t.entry]))];
  return { fmt: 'mov', adec: decs.length === 1 ? decs[0] : '', video: video.length > 0,
    hevc: video.some((t) => t.entry === 'hvc1' || t.entry === 'hev1'), webm: false };
}

// ------------------------------------------------------- Matroska / WebM --
function vint(b, p, keepMarker) {
  const first = b[p];
  let len = 1, mask = 0x80;
  while (len <= 8 && !(first & mask)) { mask >>= 1; len++; }
  if (len > 8 || p + len > b.length) return null;
  let val = keepMarker ? first : first & (mask - 1), allOnes = (first & (mask - 1)) === mask - 1;
  for (let i = 1; i < len; i++) { val = val * 256 + b[p + i]; if (b[p + i] !== 255) allOnes = false; }
  return { val, len, unknown: !keepMarker && allOnes };
}
function eachEl(b, start, end, fn) {
  let p = start;
  while (p < end) {
    const id = vint(b, p, true); if (!id) break;
    const sz = vint(b, p + id.len, false); if (!sz) break;
    const s = p + id.len + sz.len, e = sz.unknown ? end : Math.min(end, s + sz.val);
    if (fn(id.val, s, e, sz.unknown) === false) return;
    if (sz.unknown) return;
    p = e;
  }
}

function matroska(b) {
  const tracks = [];
  let segment = null;
  eachEl(b, 0, b.length, (id, s, e) => { if (id === 0x18538067) { segment = [s, e]; return false; } });
  if (!segment) throw new Error(`This WebM/MKV file has no content. ${SUPPORTED}`);
  eachEl(b, segment[0], segment[1], (id, s, e) => {
    if (id === 0x1f43b675) return false;          // first cluster: the track list is behind us
    if (id !== 0x1654ae6b) return;
    eachEl(b, s, e, (tid, ts, te) => {
      if (tid !== 0xae) return;
      const t = { type: 0, codec: '' };
      eachEl(b, ts, te, (fid, fs, fe) => {
        if (fid === 0x83) t.type = b[fs];
        if (fid === 0x86) t.codec = ascii(b, fs, Math.min(fe - fs, 40)).replace(/\0+$/, '');
      });
      tracks.push(t);
    });
    return false;
  });
  const audio = tracks.filter((t) => t.type === 2), video = tracks.filter((t) => t.type === 1);
  const other = tracks.filter((t) => t.type !== 1 && t.type !== 2 && !(t.type === 17 && t.codec.startsWith('S_TEXT/')));
  if (!audio.length) throw new Error('This file has no audio track, so there is nothing to clean.');
  const adecOf = (c) => (c in MKV_AUDIO ? MKV_AUDIO[c] : c.startsWith('A_AAC/') ? 'aac' : c.startsWith('A_PCM/') ? '' : null);
  const badA = audio.find((t) => adecOf(t.codec) === null);
  if (badA) throw new Error(`The audio in this file uses a codec we don't open ("${badA.codec}"). Export it as Opus or AAC and try again.`);
  const badV = video.find((t) => !MKV_VIDEO.has(t.codec));
  if (badV) throw new Error(`The video in this file uses a codec we don't open ("${badV.codec}"). Export it as VP9 or H.264 and try again.`);
  if (other.length) throw new Error(`This file has an extra track we don't open ("${other[0].codec}"). Remove it and try again.`);
  const decs = [...new Set(audio.map((t) => adecOf(t.codec)))];
  return { fmt: 'matroska', adec: decs.length === 1 ? decs[0] : '', video: video.length > 0, hevc: false,
    webm: video.every((t) => WEBM_VIDEO.has(t.codec)) };
}

// -------------------------------------------------------------------- WAV --
function wav(b) {
  let p = 12;
  while (p + 8 <= b.length) {
    const id = ascii(b, p, 4), size = b[p + 4] | (b[p + 5] << 8) | (b[p + 6] << 16) | (b[p + 7] << 24);
    if (id === 'fmt ') {
      let tag = b[p + 8] | (b[p + 9] << 8);
      if (tag === 0xfffe && size >= 26) tag = b[p + 32] | (b[p + 33] << 8);   // WAVE_FORMAT_EXTENSIBLE subformat
      if (tag !== 1 && tag !== 3) throw new Error('This WAV uses a compressed format we don\'t open. Save it as plain PCM and try again.');
      return { fmt: 'wav', adec: '', video: false, hevc: false, webm: false };
    }
    p += 8 + size + (size & 1);
  }
  throw new Error('This WAV file has no format header.');
}

if (typeof module !== 'undefined') module.exports = { inspectMedia };
