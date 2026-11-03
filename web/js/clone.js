// Voice cloning in the browser: a clip -> (speaker embedding [192], style tokens [50, 256]),
// the same layout as the preset voices. Ports of:
//
//   trimSilence      librosa.effects.trim(top_db=30)       (V3TurboVieNeuTTS._preclean_reference_audio)
//   kaldiFbank       kaldi-native-fbank, 80 mel bins, mean-normed (vieneu .../speaker/audio_utils.py)
//   VoiceEncoder     OnnxV3NanoEngine.prepare_reference    (vieneu/v3nano.py), denoise off
//
// Resampling is left to the caller: the page decodes the clip at 24 kHz and
// renders a 16 kHz copy with OfflineAudioContext, so no resampler lives here.

const CLONE_GRAPHS = ["speaker_encoder", "codec_encoder", "reference_encoder"];

/** librosa.effects.trim: drop leading/trailing frames quieter than `topDb` below the loudest. */
export function trimSilence(wav, { topDb = 30, frameLength = 2048, hop = 512 } = {}) {
  const pad = frameLength >> 1; // center=True, zero padding
  const nFrames = 1 + Math.floor(wav.length / hop);
  const mse = new Float64Array(nFrames);
  for (let f = 0; f < nFrames; f++) {
    let s = 0;
    const start = f * hop - pad;
    for (let i = 0; i < frameLength; i++) {
      const j = start + i;
      if (j >= 0 && j < wav.length) s += wav[j] * wav[j];
    }
    mse[f] = s / frameLength;
  }
  const ref = Math.max(1e-10, ...mse);
  const db = (p) => 10 * Math.log10(Math.max(1e-10, p)) - 10 * Math.log10(ref);
  let first = -1;
  let last = -1;
  for (let f = 0; f < nFrames; f++) {
    if (db(mse[f]) > -topDb) {
      if (first < 0) first = f;
      last = f;
    }
  }
  if (first < 0) return wav.subarray(0, 0);
  return wav.subarray(first * hop, Math.min(wav.length, (last + 1) * hop));
}

// ── Kaldi fbank ──────────────────────────────────────────────────────────────
// frame 25 ms / shift 10 ms, snip_edges, remove DC, pre-emphasis 0.97, povey
// window, 512-point power spectrum, 80 triangular mel bins from 20 Hz to Nyquist,
// log with FLT_EPSILON floor; then the mean over time is subtracted per bin.

const melScale = (f) => 1127 * Math.log(1 + f / 700);

function melBanks(nMels, sr, nFft) {
  const nBins = nFft / 2; // Kaldi uses bins 0 .. nFft/2 - 1
  const binWidth = sr / nFft;
  const lo = melScale(20);
  const hi = melScale(sr / 2);
  const delta = (hi - lo) / (nMels + 1);
  const banks = [];
  for (let m = 0; m < nMels; m++) {
    const left = lo + m * delta;
    const center = left + delta;
    const right = center + delta;
    const w = new Float64Array(nBins);
    for (let i = 0; i < nBins; i++) {
      const mel = melScale(binWidth * i);
      if (mel > left && mel < right) w[i] = mel <= center ? (mel - left) / (center - left) : (right - mel) / (right - center);
    }
    banks.push(w);
  }
  return banks;
}

/** In-place radix-2 FFT on (re, im). */
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const tr = re[b] * wr - im[b] * wi;
        const ti = re[b] * wi + im[b] * wr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** 16 kHz mono -> Float32Array [frames * nMels], mean-normalized. Returns { data, frames }. */
export function kaldiFbank(wav, { sr = 16000, nMels = 80 } = {}) {
  const frameLen = Math.round(0.025 * sr);
  const shift = Math.round(0.01 * sr);
  if (wav.length < frameLen) throw new Error("Clip too short to analyse.");
  const frames = 1 + Math.floor((wav.length - frameLen) / shift);
  const nFft = 1 << Math.ceil(Math.log2(frameLen));
  const window = Float64Array.from({ length: frameLen }, (_, i) => (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frameLen - 1))) ** 0.85);
  const banks = melBanks(nMels, sr, nFft);
  const out = new Float32Array(frames * nMels);
  const re = new Float64Array(nFft);
  const im = new Float64Array(nFft);
  for (let f = 0; f < frames; f++) {
    re.fill(0);
    im.fill(0);
    let mean = 0;
    for (let i = 0; i < frameLen; i++) mean += wav[f * shift + i];
    mean /= frameLen;
    for (let i = 0; i < frameLen; i++) re[i] = wav[f * shift + i] - mean;
    for (let i = frameLen - 1; i > 0; i--) re[i] -= 0.97 * re[i - 1];
    re[0] -= 0.97 * re[0];
    for (let i = 0; i < frameLen; i++) re[i] *= window[i];
    fft(re, im);
    for (let m = 0; m < nMels; m++) {
      const w = banks[m];
      let e = 0;
      for (let i = 0; i < w.length; i++) if (w[i]) e += w[i] * (re[i] * re[i] + im[i] * im[i]);
      out[f * nMels + m] = Math.log(Math.max(e, 1.1920928955078125e-7));
    }
  }
  for (let m = 0; m < nMels; m++) {
    let s = 0;
    for (let f = 0; f < frames; f++) s += out[f * nMels + m];
    s /= frames;
    for (let f = 0; f < frames; f++) out[f * nMels + m] -= s;
  }
  return { data: out, frames };
}

export class VoiceEncoder {
  /** @param clone  nano.json's `clone` section; graphs: ONNX bytes by name */
  static async create(ort, clone, graphs, opts = {}) {
    const so = { executionProviders: opts.executionProviders ?? ["wasm"], graphOptimizationLevel: "all" };
    const sessions = {};
    for (const g of CLONE_GRAPHS) sessions[g] = await ort.InferenceSession.create(graphs[g], so);
    return new VoiceEncoder(ort, clone, sessions);
  }

  constructor(ort, clone, sessions) {
    this.ort = ort;
    this.cfg = clone;
    this.sessions = sessions;
    this.fps = 24000 / 256 / clone.group;
  }

  /** 192-d x-vector from a 16 kHz clip (at most max_seconds). */
  async speakerEmbedding(wav16) {
    const capped = wav16.subarray(0, Math.floor(this.cfg.max_seconds * 16000));
    const { data, frames } = kaldiFbank(capped);
    const { output } = await this.sessions.speaker_encoder.run({ input: new this.ort.Tensor("float32", data, [1, frames, 80]) });
    return Float32Array.from(output.data);
  }

  /** Codec latent of the first ref_seconds -> normalized, grouped -> [50, 256] style tokens. */
  async styleTokens(wav24) {
    const m24 = wav24.slice(0, Math.floor(24000 * this.cfg.ref_seconds));
    const { mu } = await this.sessions.codec_encoder.run({ wav: new this.ort.Tensor("float32", m24, [1, 1, m24.length]) });
    const [, C, T] = mu.dims;
    const g = this.cfg.group;
    const { latent_mean: mean, latent_std: std, latent_scale: scale } = this.cfg;
    // [1, C, T] -> pad T to a multiple of g -> [1, C*g, T/g] with channel c*g + k = frame t*g + k
    const Tg = Math.ceil(T / g);
    const frames = Math.min(Tg, Math.floor(this.cfg.ref_seconds * this.fps), this.cfg.ref_max_frames);
    const ref = new Float32Array(C * g * frames);
    for (let c = 0; c < C; c++) {
      for (let t = 0; t < frames; t++) {
        for (let k = 0; k < g; k++) {
          const src = t * g + k;
          const v = src < T ? ((mu.data[c * T + src] - mean[c]) / std[c]) * scale : 0;
          ref[(c * g + k) * frames + t] = v;
        }
      }
    }
    const { style } = await this.sessions.reference_encoder.run({
      ref: new this.ort.Tensor("float32", ref, [1, C * g, frames]),
      ref_mask: new this.ort.Tensor("bool", new Uint8Array(frames).fill(1), [1, frames]),
    });
    return Float32Array.from(style.data);
  }

  /** Trimmed clip at 24 kHz and 16 kHz -> { spk, style }. */
  async enroll(wav24, wav16) {
    return { spk: await this.speakerEmbedding(wav16), style: await this.styleTokens(wav24) };
  }
}
