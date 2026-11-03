// Inference worker: owns onnxruntime-web, the sea-g2p WASM phonemizer and the
// Nano engine, so the page stays responsive while audio is generated.
//
// in:  { type: "init", backend: "webgpu" | "wasm" }
//      { type: "synth", id, text, voice (preset name | { spk, style }), steps, cfg, speed, seed }
//      { type: "clone", id, wav24, wav16 }   trimmed clip, 24 kHz and 16 kHz mono
// out: { type: "progress", stage, loaded, total, file }
//      { type: "ready", backend, voices, loadMs }
//      { type: "chunk", id, index, count, text, phonemes }
//      { type: "done", id, wav (Float32Array), sampleRate, genMs, chunks }
//      { type: "cloned", id, spk, style, ms }
//      { type: "error", id?, message }

import * as ort from "../vendor/ort/ort.webgpu.min.mjs";
import initG2p, { SeaG2p, punc_norm } from "../g2p/sea_g2p_rs.js";
import { NanoEngine } from "./engine.js";
import { textToChunks, phonemizeChunk } from "./text.js";
import { joinChunks } from "./audio.js";
import { MODEL_CACHE, MODEL_CACHE_PREFIX, versionedUrl } from "./config.js";
import { VoiceEncoder } from "./clone.js";

const GRAPHS = ["text_encoder", "duration_predictor", "vector_estimator", "codec_decoder"];
const CLONE_GRAPHS = ["speaker_encoder", "codec_encoder", "reference_encoder"];

ort.env.wasm.wasmPaths = new URL("../vendor/ort/", import.meta.url).href;
ort.env.wasm.numThreads = self.crossOriginIsolated ? Math.min(navigator.hardwareConcurrency || 4, 8) : 1;

let engine = null;
let g2p = null;
let encoder = null; // voice cloning, loaded on the first clone request
let get = null; // path -> bytes through the model cache, set by init
let backendUsed = "wasm";

const post = (msg, transfer) => self.postMessage(msg, transfer ?? []);

/**
 * Fetch a manifest file once, then serve it from Cache Storage (works offline).
 * A file split for hosting (`parts` in assets.json, see scripts/build_dist.mjs)
 * is fetched piece by piece and cached whole under its own versioned URL.
 */
async function cachedBytes(f, base) {
  const url = versionedUrl(f, base);
  const file = f.path.split("/").pop();
  const cache = await caches.open(MODEL_CACHE);
  const res = await cache.match(url);
  if (res) {
    post({ type: "progress", stage: "cached", file });
    return new Uint8Array(await res.arrayBuffer());
  }
  const urls = f.parts
    ? Array.from({ length: f.parts }, (_, i) => `${new URL(`${f.path}.part${i}`, base).href}?v=${f.hash}`)
    : [url];
  const chunks = [];
  let loaded = 0;
  for (const u of urls) {
    const net = await fetch(u);
    if (!net.ok) throw new Error(`${u}: HTTP ${net.status}`);
    const reader = net.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.length;
      post({ type: "progress", stage: "download", file, loaded, total: f.bytes });
    }
  }
  const blob = new Blob(chunks);
  if (blob.size !== f.bytes) throw new Error(`${f.path}: got ${blob.size} bytes, expected ${f.bytes}`);
  await cache.put(url, new Response(blob));
  return new Uint8Array(await blob.arrayBuffer());
}

/** Inflate gzip bytes. Passes plain bytes through, in case a host already set
 *  Content-Encoding: gzip on the .gz file and the browser decoded it. */
async function gunzip(bytes) {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function init(backend) {
  const t0 = performance.now();
  const base = new URL("../", import.meta.url);
  // assets.json comes through the service worker (network-first, cached for offline).
  const manifest = (await (await fetch(new URL("assets.json", base))).json()).files.filter((f) => f.cache === "models");
  const byPath = Object.fromEntries(manifest.map((f) => [f.path, f]));
  const urls = Object.fromEntries(manifest.map((f) => [f.path, versionedUrl(f, base)]));
  get = (path) => cachedBytes(byPath[path], base);
  // onnxruntime's WASM goes through the same cache (it can be split for hosting);
  // handing it over as bytes stops ort from fetching it itself.
  ort.env.wasm.wasmBinary = await get("vendor/ort/ort-wasm-simd-threaded.asyncify.wasm");
  const [meta, bin, dict] = await Promise.all([
    get("models/nano.json").then((b) => JSON.parse(new TextDecoder().decode(b))),
    get("models/nano.bin").then((b) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4)),
    get("g2p/sea_g2p.bin.gz").then(gunzip),
  ]);
  const graphs = {};
  for (const g of GRAPHS) graphs[g] = await get(`models/${g}.onnx`);

  post({ type: "progress", stage: "compile", file: "sea-g2p" });
  await initG2p();
  const sea = new SeaG2p(dict);
  g2p = {
    normalize: (t, p) => sea.normalize(t, p),
    phonemize: (t, p) => sea.phonemize(t, p),
    puncNorm: (t) => punc_norm(t),
  };

  post({ type: "progress", stage: "compile", file: "onnx" });
  let used = backend;
  try {
    engine = await NanoEngine.create(ort, meta, bin, graphs, { executionProviders: [backend] });
  } catch (e) {
    if (backend === "wasm") throw e;
    console.warn(`${backend} failed, falling back to wasm:`, e);
    used = "wasm";
    engine = await NanoEngine.create(ort, meta, bin, graphs, { executionProviders: ["wasm"] });
  }
  backendUsed = used;
  // Everything current is cached and working: drop stale file versions and old buckets
  // (the optional cloning graphs are in `urls` too, so a cached copy survives).
  const current = new Set(Object.values(urls));
  const cache = await caches.open(MODEL_CACHE);
  for (const req of await cache.keys()) if (!current.has(req.url)) await cache.delete(req);
  for (const k of await caches.keys()) {
    if (k.startsWith(MODEL_CACHE_PREFIX) && k !== MODEL_CACHE) await caches.delete(k);
  }
  post({
    type: "ready",
    backend: used,
    threads: ort.env.wasm.numThreads,
    voices: meta.voices.map(({ name, description, gender }) => ({ name, description, gender })),
    defaultVoice: meta.default_voice,
    loadMs: performance.now() - t0,
  });
}

async function synth({ id, text, voice, steps, cfg, speed, seed }) {
  const t0 = performance.now();
  const v = typeof voice === "string" ? engine.voice(voice) : { spk: Float32Array.from(voice.spk), style: Float32Array.from(voice.style) };
  const { chunks, gaps } = textToChunks(g2p, text);
  const wavs = [];
  for (let i = 0; i < chunks.length; i++) {
    const phonemes = phonemizeChunk(g2p, chunks[i]);
    post({ type: "chunk", id, index: i, count: chunks.length, text: chunks[i], phonemes });
    wavs.push(await engine.infer(phonemes, v, {
      steps, cfg, speed,
      seed: seed === undefined || seed === null ? undefined : seed + i,
      onStep: (s, n) => post({ type: "step", id, index: i, step: s, steps: n }),
    }));
  }
  const wav = joinChunks(wavs, engine.sampleRate, gaps);
  post({ type: "done", id, wav, sampleRate: engine.sampleRate, genMs: performance.now() - t0, chunks: chunks.length }, [wav.buffer]);
}

async function clone({ id, wav24, wav16 }) {
  if (!encoder) {
    const graphs = {};
    for (const g of CLONE_GRAPHS) graphs[g] = await get(`models/clone/${g}.onnx`);
    post({ type: "progress", stage: "compile", file: "clone" });
    try {
      encoder = await VoiceEncoder.create(ort, engine.meta.clone, graphs, { executionProviders: [backendUsed] });
    } catch (e) {
      if (backendUsed === "wasm") throw e;
      encoder = await VoiceEncoder.create(ort, engine.meta.clone, graphs, { executionProviders: ["wasm"] });
    }
  }
  const t0 = performance.now();
  const { spk, style } = await encoder.enroll(wav24, wav16);
  post({ type: "cloned", id, spk, style, ms: performance.now() - t0 }, [spk.buffer, style.buffer]);
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === "init") await init(data.backend);
    else if (data.type === "synth") await synth(data);
    else if (data.type === "clone") await clone(data);
  } catch (e) {
    post({ type: "error", id: data.id, message: e?.message ?? String(e) });
  }
};
