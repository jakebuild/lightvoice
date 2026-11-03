// Edge trimming, chunk joining and WAV encoding: ports of
// vieneu_utils/core_utils.py (trim_and_fade, join_audio_chunks, gaps_to_silence).

const EDGE_THRESH_DB = -45.0; // "voiced" threshold on a 10 ms mean|x| envelope
const EDGE_KEEP_S = 0.04; // silence kept at each end after trimming
const EDGE_FADE_S = 0.015; // cosine fade at both edges so joins don't click
export const GAP_SILENCE = { para: 0.7, sentence: 0.5, minor: 0.3 };

/** [lead, tail]: samples of silence at the start and end of `wav`. */
export function edgeSilence(wav, sr, threshDb = EDGE_THRESH_DB, winS = 0.01) {
  const win = Math.max(1, Math.floor(winS * sr));
  const nWin = Math.floor(wav.length / win);
  if (nWin === 0) return [wav.length, 0];
  const thresh = 10 ** (threshDb / 20);
  let first = -1;
  let last = -1;
  for (let w = 0; w < nWin; w++) {
    let s = 0;
    for (let i = w * win; i < (w + 1) * win; i++) s += Math.abs(wav[i]);
    if (s / win > thresh) {
      if (first < 0) first = w;
      last = w;
    }
  }
  if (first < 0) return [wav.length, 0];
  return [first * win, wav.length - (last + 1) * win];
}

export function trimAndFade(wav, sr) {
  if (wav.length === 0) return wav;
  const [lead, tail] = edgeSilence(wav, sr);
  const keep = Math.floor(EDGE_KEEP_S * sr);
  const a = Math.max(0, lead - keep);
  const b = wav.length - Math.max(0, tail - keep);
  const out = wav.slice(a, Math.max(a, b));
  const n = Math.min(Math.floor(EDGE_FADE_S * sr), Math.floor(out.length / 2));
  for (let i = 0; i < n; i++) {
    const r = 0.5 - 0.5 * Math.cos((Math.PI * i) / (n - 1 || 1));
    out[i] *= r;
    out[out.length - 1 - i] *= r;
  }
  return out;
}

/** Zeros to insert so the real pause (prev tail + zeros + next lead) reaches `pauseS`. */
export function pausePadSamples(prev, next, sr, pauseS) {
  let [leadPrev, tail] = edgeSilence(prev, sr);
  if (leadPrev === prev.length) tail = prev.length;
  const [lead] = edgeSilence(next, sr);
  return Math.max(0, Math.floor(pauseS * sr) - tail - lead);
}

export function joinChunks(chunks, sr, gaps) {
  const parts = [];
  chunks.forEach((c, i) => {
    if (i > 0) {
      const pause = GAP_SILENCE[gaps[i - 1]] ?? GAP_SILENCE.sentence;
      const pad = pausePadSamples(chunks[i - 1], c, sr, pause);
      if (pad > 0) parts.push(new Float32Array(pad));
    }
    parts.push(c);
  });
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** 16-bit PCM mono WAV. */
export function encodeWav(samples, sr) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sr, true);
  v.setUint32(28, sr * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}
