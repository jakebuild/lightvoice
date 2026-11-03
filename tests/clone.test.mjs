// web/js/clone.js against the Python cloning pipeline, stage by stage
// (golden data from scripts/prepare_assets.py write_golden_clone).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as ort from "onnxruntime-web";
import { trimSilence, kaldiFbank, VoiceEncoder } from "../web/js/clone.js";
import { nanoSnapshot } from "./hf.mjs";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root));
const f32 = (buf) => new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
const golden = JSON.parse(await read("tests/golden/clone.json"));
const g = async (name) => f32(await read(`tests/golden/clone_${name}.bin`));
const meta = JSON.parse(await read("web/models/nano.json"));

ort.env.wasm.numThreads = 1;

const cosine = (a, b) => {
  let ab = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) {
    ab += a[i] * b[i];
    aa += a[i] * a[i];
    bb += b[i] * b[i];
  }
  return ab / Math.sqrt(aa * bb);
};
const maxAbs = (a, b) => a.reduce((m, x, i) => Math.max(m, Math.abs(x - b[i])), 0);

async function encoder(dir) {
  const graphs = {};
  for (const n of ["speaker_encoder", "codec_encoder", "reference_encoder"]) graphs[n] = new Uint8Array(await readFile(`${dir}/${n}.onnx`));
  return VoiceEncoder.create(ort, meta.clone, graphs);
}

test("trimSilence matches librosa.effects.trim", async () => {
  assert.equal(trimSilence(await g("clip24")).length, golden.trimmed_samples);
});

test("kaldiFbank matches kaldi-native-fbank", async () => {
  const { data, frames } = kaldiFbank(await g("wav16"));
  assert.equal(frames, golden.fbank_shape[0]);
  const err = maxAbs(data, await g("fbank"));
  assert.ok(err < 1e-3, `max |diff| ${err}`);
});

for (const [name, dir, minCos] of [
  ["original fp32 graphs", nanoSnapshot(golden.fp32_snapshot), 0.9999],
  ["shipped fp16-weight graphs", new URL("web/models/clone", root).pathname, 0.995],
]) {
  test(`enroll matches prepare_reference: ${name}`, {
    timeout: 300_000,
    skip: !dir && "original snapshot not in the Hugging Face cache (run scripts/prepare_assets.py)",
  }, async () => {
    const enc = await encoder(dir);
    const trimmed = trimSilence(await g("clip24"));
    const style = await enc.styleTokens(trimmed);
    const spk = await enc.speakerEmbedding(await g("wav16"));
    const cs = cosine(spk, await g("spk"));
    const ct = cosine(style, await g("style"));
    console.log(`  ${name}: speaker cos ${cs.toFixed(5)}, style cos ${ct.toFixed(5)}`);
    assert.ok(cs > minCos, `speaker embedding cos ${cs}`);
    assert.ok(ct > minCos, `style tokens cos ${ct}`);
  });
}
