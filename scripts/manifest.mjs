// Write web/assets.json: every file the app downloads once and keeps, with its
// size and a content hash. The page uses the sizes to say what is already on
// the device; the worker fetches model files as `path?v=<hash>`, so a change to
// one file (say a new voice in nano.bin) re-downloads that file only.
// Run after prepare_assets.py, vendor_ort.mjs and build_g2p.sh.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const web = new URL("../web/", import.meta.url);
// cache: which Cache Storage bucket holds the file (see js/config.js, sw.js).
const files = [
  ...["nano.json", "nano.bin", "text_encoder.onnx", "duration_predictor.onnx", "vector_estimator.onnx", "codec_decoder.onnx"]
    .map((f) => ({ path: `models/${f}`, cache: "models" })),
  { path: "g2p/sea_g2p.bin.gz", cache: "models" },
  // Voice cloning: fetched only when someone clones a voice, so not part of the first load.
  ...["speaker_encoder.onnx", "codec_encoder.onnx", "reference_encoder.onnx"]
    .map((f) => ({ path: `models/clone/${f}`, cache: "models", optional: "clone" })),
  { path: "g2p/sea_g2p_rs_bg.wasm", cache: "shell" },
  // Loaded by the worker and handed to onnxruntime as env.wasm.wasmBinary, so it
  // can be split like the graphs (it is over Cloudflare Pages' 25 MiB file limit).
  { path: "vendor/ort/ort-wasm-simd-threaded.asyncify.wasm", cache: "models" },
];
for (const f of files) {
  const bytes = await readFile(new URL(f.path, web));
  f.bytes = bytes.length;
  f.hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
}
await writeFile(new URL("assets.json", web), JSON.stringify({ files }, null, 1) + "\n");
const mb = (list) => (list.reduce((n, f) => n + f.bytes, 0) / 1e6).toFixed(0);
console.log(`web/assets.json: ${files.length} files, ${mb(files.filter((f) => !f.optional))} MB + ${mb(files.filter((f) => f.optional))} MB optional`);
