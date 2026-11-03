// Runs the browser engine (web/js/engine.js) in Node on onnxruntime-web's WASM
// backend and compares it with the Python reference written by
// scripts/prepare_assets.py: same phonemes, same noise -> same waveform.
//
//   node --test tests/

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as ort from "onnxruntime-web";
import { NanoEngine } from "../web/js/engine.js";
import { nanoSnapshot } from "./hf.mjs";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root));
const f32 = (buf) => new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);

ort.env.wasm.numThreads = 1;

const golden = JSON.parse(await read("tests/golden/engine.json"));

async function loadEngine(graphDir) {
  const meta = JSON.parse(await read("web/models/nano.json"));
  const bin = f32(await read("web/models/nano.bin"));
  const graphs = {};
  for (const g of ["text_encoder", "duration_predictor", "vector_estimator", "codec_decoder"]) {
    graphs[g] = new Uint8Array(await readFile(`${graphDir}/${g}.onnx`));
  }
  return NanoEngine.create(ort, meta, bin, graphs);
}

// fp32: the original graphs must match Python sample for sample.
// fp16: the shipped graphs (fp16 weights) only differ by weight rounding; a
// different random seed moves the waveform far more than that.
const cases = [
  ["original fp32 graphs", nanoSnapshot(golden.fp32_snapshot), 40],
  ["shipped fp16-weight graphs", new URL("web/models", root).pathname, 15],
];

for (const [name, dir, minSnr] of cases) test(`engine matches the Python reference: ${name}`, {
  timeout: 600_000,
  skip: !dir && "original snapshot not in the Hugging Face cache (run scripts/prepare_assets.py)",
}, async () => {
  const noise = f32(await read("tests/golden/noise.bin")).slice();
  const ref = f32(await read("tests/golden/wav.bin"));

  const engine = await loadEngine(dir);
  const voice = engine.voice(golden.voice);
  const prep = await engine.prepare(golden.phonemes, voice);
  assert.deepEqual(Array.from(prep.ids, Number), golden.ids);
  assert.ok(Math.abs(prep.logSeconds - golden.log_seconds) < 1e-2, `log_seconds ${prep.logSeconds} vs ${golden.log_seconds}`);
  assert.equal(prep.frames, golden.frames);

  const t0 = performance.now();
  const wav = await engine.sample(prep, voice, noise, { steps: golden.steps, cfg: golden.cfg });
  const secs = (performance.now() - t0) / 1000;
  assert.equal(wav.length, ref.length);

  let err = 0;
  let sig = 0;
  for (let i = 0; i < ref.length; i++) {
    err += (wav[i] - ref[i]) ** 2;
    sig += ref[i] ** 2;
  }
  const snr = 10 * Math.log10(sig / err);
  console.log(`  ${ref.length / 24000}s audio in ${secs.toFixed(2)}s (${golden.steps} steps, 1 thread), SNR vs Python ${snr.toFixed(1)} dB`);
  assert.ok(snr > minSnr, `waveform differs from Python: SNR ${snr.toFixed(1)} dB`);
});
