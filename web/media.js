// Read a video's audio and write the clean copy, without FFmpeg.
//
// Mediabunny (pure TypeScript, so a hostile file can't corrupt memory) parses
// MP4/MOV/WebM/MKV/WAV. The browser's own decoders turn the audio into samples.
// Video is copied packet by packet and never decoded. The clean audio is encoded
// by the browser's AAC/Opus encoder; where AAC is missing, a small wasm encoder
// takes over, and it only ever sees our own clean audio.
import * as MB from './vendor/mediabunny.min.mjs';

const FORMATS = [MB.MP4, MB.QTFF, MB.MATROSKA, MB.WEBM, MB.WAVE];
const WEBM_VIDEO = new Set(['vp8', 'vp9', 'av1']);

let aacEncoder = null;
async function ensureAac() {
  if (!aacEncoder) {
    aacEncoder = (async () => {
      if (await MB.canEncodeAudio('aac')) return 'browser';
      const { registerAacEncoder } = await import('./vendor/mediabunny-aac-encoder.min.mjs');
      registerAacEncoder();
      return 'wasm';
    })();
  }
  return aacEncoder;
}

/** Decode the primary audio track to planar float samples. */
export async function readAudio(blob, onProgress) {
  const input = new MB.Input({ source: new MB.BlobSource(blob), formats: FORMATS });
  let format;
  try { format = await input.getFormat(); } catch { throw new Error('This file type isn\'t supported. Use MP4, MOV, M4A, WebM, MKV or WAV.'); }
  const track = await input.getPrimaryAudioTrack();
  if (!track) throw new Error('This file has no audio track, so there is nothing to clean.');
  const video = await input.getPrimaryVideoTrack();
  const sampleRate = await track.getSampleRate();
  const nch = Math.min(await track.getNumberOfChannels(), 2);
  const duration = await input.computeDuration();
  let start = 0, channels;

  if (await track.canDecode()) {
    const parts = [];
    let total = 0, first = null;
    for await (const { buffer, timestamp } of new MB.AudioBufferSink(track).buffers()) {
      if (first === null) first = timestamp;
      parts.push(buffer);
      total += buffer.length;
      if (duration) onProgress?.(Math.min(timestamp / duration, 1));
    }
    channels = Array.from({ length: nch }, () => new Float32Array(total));
    let off = 0;
    for (const b of parts) {
      for (let c = 0; c < nch; c++) channels[c].set(b.getChannelData(Math.min(c, b.numberOfChannels - 1)), off);
      off += b.length;
    }
    start = first ?? 0;
  } else {
    // Older browsers without WebCodecs audio: the Web Audio decoder reads the whole file.
    const ctx = new OfflineAudioContext(nch, 1, sampleRate);
    const ab = await ctx.decodeAudioData(await blob.arrayBuffer());
    channels = Array.from({ length: nch }, (_, c) => ab.getChannelData(Math.min(c, ab.numberOfChannels - 1)));
    start = await input.getFirstTimestamp([track]).catch(() => 0);
  }
  if (!channels[0].length) throw new Error('The audio track is empty.');
  return { input, format, track, video, sampleRate, channels, start, duration, size: blob.size };
}

// "Smaller file": re-encode the picture at most 1080p on the short side, ~5 Mbps for 1080p,
// with the device's own encoder. Skipped when the source is already that small.
const SHORT_SIDE = 1080, BITS_PER_PIXEL = 5e6 / (1920 * 1080);
export async function planShrink(src) {
  const v = src.video;
  const dw = await v.getDisplayWidth(), dh = await v.getDisplayHeight();
  const scale = Math.min(1, SHORT_SIDE / Math.min(dw, dh));
  const even = (x) => Math.max(2, Math.round(x / 2) * 2);
  const width = even(dw * scale), height = even(dh * scale);
  const bitrate = Math.round(Math.max(1.2e6, width * height * BITS_PER_PIXEL));
  const sourceBits = (src.size * 8) / Math.max(src.duration, 0.1);
  if (sourceBits < bitrate * 1.3) return null;            // already small: keep the original picture
  for (const codec of ['avc', 'vp9']) {
    if (await MB.canEncodeVideo(codec, { width, height, bitrate })) return { codec, width, height, bitrate };
  }
  throw new Error('This browser can\'t re-encode video. Turn off "Smaller file" and try again.');
}

/** Write a new file: the video (copied, or re-encoded smaller) plus the clean audio. No metadata is carried over. */
export async function writeClean(src, clean, onProgress, opts = {}) {
  const { video, sampleRate, start } = src;
  const vcodec = video ? video.codec : null;
  const isMatroska = src.format === MB.WEBM || src.format === MB.MATROSKA;
  const shrink = opts.smaller && video ? await planShrink(src) : null;
  let format, ext, type, acodec;
  if (shrink) {
    const mp4 = shrink.codec === 'avc';
    format = mp4 ? new MB.Mp4OutputFormat({ fastStart: 'in-memory' }) : new MB.WebMOutputFormat();
    ext = mp4 ? 'mp4' : 'webm';
    type = mp4 ? 'video/mp4' : 'video/webm';
    acodec = mp4 ? 'aac' : 'opus';
  } else if (video && isMatroska) {
    const webm = WEBM_VIDEO.has(vcodec);
    format = webm ? new MB.WebMOutputFormat() : new MB.MkvOutputFormat();
    ext = webm ? 'webm' : 'mkv';
    type = webm ? 'video/webm' : 'video/x-matroska';
    acodec = 'opus';
  } else {
    format = new MB.Mp4OutputFormat({ fastStart: 'in-memory' });
    ext = video ? 'mp4' : 'm4a';
    type = video ? 'video/mp4' : 'audio/mp4';
    acodec = 'aac';
  }
  const encoder = acodec === 'aac' ? await ensureAac() : 'browser';
  if (acodec === 'opus' && !(await MB.canEncodeAudio('opus'))) {
    throw new Error('This browser can\'t encode Opus audio for WebM. Try Chrome, Firefox or Safari 26.');
  }

  const output = new MB.Output({ format, target: new MB.BufferTarget() });
  let vsrc = null;
  if (shrink) {
    // Frames come out upright (the encoder applies each frame's rotation), so the track needs no rotation flag.
    vsrc = new MB.VideoSampleSource({ codec: shrink.codec, bitrate: shrink.bitrate, keyFrameInterval: 2, transform: { width: shrink.width } });
    output.addVideoTrack(vsrc);
  } else if (video) {
    if (!vcodec) throw new Error('The video in this file uses a codec we don\'t open.');
    vsrc = new MB.EncodedVideoPacketSource(vcodec);
    output.addVideoTrack(vsrc, { rotation: await video.getRotation() });
  }
  const asrc = new MB.AudioSampleSource({ codec: acodec, bitrate: acodec === 'aac' ? 192000 : 160000 });
  output.addAudioTrack(asrc);
  await output.start();

  const nch = clean.length, n = clean[0].length;
  const feedAudio = async () => {
    const step = sampleRate;   // one second per sample
    for (let i = 0; i < n; i += step) {
      const len = Math.min(step, n - i);
      const data = new Float32Array(len * nch);
      for (let c = 0; c < nch; c++) data.set(clean[c].subarray(i, i + len), c * len);
      const s = new MB.AudioSample({ data, format: 'f32-planar', numberOfChannels: nch, sampleRate, timestamp: start + i / sampleRate });
      await asrc.add(s);
      s.close();
      if (!shrink) onProgress?.(i / n);
    }
    asrc.close();
  };
  const feedVideo = async () => {
    if (!video) return;
    if (shrink) {
      for await (const sample of new MB.VideoSampleSink(video).samples()) {
        await vsrc.add(sample);
        if (src.duration) onProgress?.(Math.min(sample.timestamp / src.duration, 1));
        sample.close();
      }
      vsrc.close();
      return;
    }
    const config = await video.getDecoderConfig();
    let first = true;
    for await (const packet of new MB.EncodedPacketSink(video).packets()) {
      await vsrc.add(packet, first ? { decoderConfig: config } : undefined);
      first = false;
    }
    vsrc.close();
  };
  await Promise.all([feedVideo(), feedAudio()]);   // fed together so the muxer can interleave
  await output.finalize();
  return { buffer: output.target.buffer, ext, type, encoder, acodec, shrink, keptOriginal: !!(opts.smaller && video && !shrink) };
}
