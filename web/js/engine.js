// VieNeu-TTS v3 Nano in onnxruntime-web: a port of vieneu/v3nano.py
// (OnnxV3NanoEngine.infer). Phonemes in, 24 kHz float32 audio out.
//
//   text_encoder(ids, style)              -> ctx [1, L, 256]
//   duration_predictor(ctx, mask, spk)    -> log seconds of speech
//   vector_estimator(x, t, ctx, ...)      -> flow velocity, Euler-integrated `steps` times,
//                                            run twice per step for classifier-free guidance
//   codec_decoder(x)                      -> waveform
//
// Works in a browser (WebGPU or WASM) and in Node (WASM), so tests can run it
// against the Python reference.

import { trimAndFade } from "./audio.js";

const GRAPHS = ["text_encoder", "duration_predictor", "vector_estimator", "codec_decoder"];
const MAX_CHUNK_SECONDS = 15; // training clips were <= 15 s; longer targets drift
const MIN_FRAMES = 2;

export class NanoEngine {
  /**
   * @param {object} ort         the onnxruntime-web module
   * @param {object} meta        models/nano.json
   * @param {Float32Array} bin   models/nano.bin
   * @param {Record<string, Uint8Array|string>} graphs  ONNX bytes (or URLs) by graph name
   * @param {object} [opts]      { executionProviders }
   */
  static async create(ort, meta, bin, graphs, opts = {}) {
    const so = {
      executionProviders: opts.executionProviders ?? ["wasm"],
      graphOptimizationLevel: "all",
    };
    const sessions = {};
    for (const g of GRAPHS) sessions[g] = await ort.InferenceSession.create(graphs[g], so);
    const engine = new NanoEngine(ort, meta, bin, sessions);
    await engine.#buildNullContext();
    return engine;
  }

  constructor(ort, meta, bin, sessions) {
    this.ort = ort;
    this.meta = meta;
    this.sessions = sessions;
    this.sampleRate = meta.sample_rate;
    this.channels = meta.latent_channels;
    const slice = ([off, n]) => bin.subarray(off, off + n);
    this.nullSpk = slice(meta.tensors.null_spk);
    this.nullStyle = slice(meta.tensors.null_style);
    this.voices = new Map(meta.voices.map((v) => [v.name, { ...v, spk: slice(v.spk), style: slice(v.style) }]));
    // <|emotion_k|> -> single vocab char (①②③), exactly as in training
    this.emotionTags = Object.entries(meta.emotion_tags);
  }

  // The unconditional text context is voice-independent: build it once.
  async #buildNullContext() {
    const ids = BigInt64Array.from([this.meta.bos_id, this.meta.eos_id].map(BigInt));
    this.nullCtx = await this.#textContext(ids, this.nullStyle);
    this.nullMask = this.#mask(ids);
  }

  /** Phone string (may contain <|emotion_k|>) -> ids. Unknown characters are dropped. */
  encodePhones(phones) {
    let s = phones;
    for (const [tag, ch] of this.emotionTags) s = s.split(tag).join(ch);
    const ids = [this.meta.bos_id];
    for (const ch of s) {
      const id = this.meta.vocab[ch];
      if (id !== undefined) ids.push(id);
    }
    ids.push(this.meta.eos_id);
    return BigInt64Array.from(ids.map(BigInt));
  }

  #tensor(type, data, dims) {
    return new this.ort.Tensor(type, data, dims);
  }

  #mask(ids) {
    return this.#tensor("bool", Uint8Array.from(ids, (i) => (i !== BigInt(this.meta.pad_id) ? 1 : 0)), [1, ids.length]);
  }

  #style(style) {
    return this.#tensor("float32", style, [1, this.meta.n_style, this.meta.style_dim]);
  }

  async #textContext(ids, style) {
    const out = await this.sessions.text_encoder.run({
      ids: this.#tensor("int64", ids, [1, ids.length]),
      style: this.#style(style),
    });
    return out.ctx;
  }

  /** Text side of a chunk: context, mask and predicted length in frames. */
  async prepare(phonemes, voice, speed = 1) {
    const ids = this.encodePhones(phonemes);
    const ctx = await this.#textContext(ids, voice.style);
    const mask = this.#mask(ids);
    const spk = this.#tensor("float32", voice.spk, [1, voice.spk.length]);
    const { log_seconds } = await this.sessions.duration_predictor.run({ ctx_mask: mask, ctx, spk });
    const secs = Math.min(Math.exp(log_seconds.data[0]) / Math.max(speed, 1e-3), MAX_CHUNK_SECONDS);
    const frames = Math.max(MIN_FRAMES, Math.round(secs * this.meta.flow_fps));
    return { ids, ctx, mask, spk, logSeconds: log_seconds.data[0], frames };
  }

  /**
   * Euler-integrate the flow from `noise` ([channels * frames], consumed) and decode.
   * Returns the raw decoder waveform (no trimming), for parity tests.
   */
  async sample(prep, voice, noise, { steps = 16, cfg = 3.0, sway = 0.0, onStep } = {}) {
    const { frames } = prep;
    const dims = [1, this.channels, frames];
    const n = Math.max(1, steps | 0);
    const tg = Array.from({ length: n + 1 }, (_, i) => {
      const u = i / n;
      return u + sway * (Math.cos((Math.PI / 2) * u) - 1 + u);
    });
    const style = this.#style(voice.style);
    const nullSpk = this.#tensor("float32", this.nullSpk, [1, this.nullSpk.length]);
    const nullStyle = this.#style(this.nullStyle);
    const x = noise;
    for (let i = 0; i < n; i++) {
      const xt = this.#tensor("float32", x, dims);
      const t = this.#tensor("float32", Float32Array.of(tg[i]), [1]);
      const vc = (await this.sessions.vector_estimator.run({
        x: xt, t, ctx: prep.ctx, ctx_mask: prep.mask, spk: prep.spk, style,
      })).v.data;
      const dt = Math.fround(tg[i + 1] - tg[i]);
      if (cfg > 0) {
        const vu = (await this.sessions.vector_estimator.run({
          x: xt, t, ctx: this.nullCtx, ctx_mask: this.nullMask, spk: nullSpk, style: nullStyle,
        })).v.data;
        for (let k = 0; k < x.length; k++) x[k] += dt * (vu[k] + cfg * (vc[k] - vu[k]));
      } else {
        for (let k = 0; k < x.length; k++) x[k] += dt * vc[k];
      }
      onStep?.(i + 1, n);
    }
    const { wav } = await this.sessions.codec_decoder.run({ x: this.#tensor("float32", x, dims) });
    return wav.data;
  }

  /** One chunk of phonemes -> trimmed, faded 24 kHz waveform. */
  async infer(phonemes, voice, { steps = 16, cfg = 3.0, sway = 0.0, speed = 1.0, seed, onStep } = {}) {
    const prep = await this.prepare(phonemes, voice, speed);
    const noise = gaussian(this.channels * prep.frames, seed);
    const wav = await this.sample(prep, voice, noise, { steps, cfg, sway, onStep });
    const out = new Float32Array(wav.length);
    for (let i = 0; i < wav.length; i++) out[i] = Math.max(-1, Math.min(1, wav[i]));
    return trimAndFade(out, this.sampleRate);
  }

  voice(name) {
    const v = this.voices.get(name ?? this.meta.default_voice);
    if (!v) throw new Error(`Voice '${name}' not found. Available: ${[...this.voices.keys()].join(", ")}`);
    return v;
  }
}

/** Standard-normal noise. Seeded (mulberry32 + Box-Muller) when `seed` is given. */
export function gaussian(n, seed) {
  let rand = Math.random;
  if (seed !== undefined && seed !== null) {
    let a = seed >>> 0;
    rand = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const r = Math.sqrt(-2 * Math.log(1 - rand()));
    const th = 2 * Math.PI * rand();
    out[i] = r * Math.cos(th);
    if (i + 1 < n) out[i + 1] = r * Math.sin(th);
  }
  return out;
}
