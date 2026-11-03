// Copy onnxruntime-web's browser runtime into web/vendor/ort so the app has no
// CDN dependency and works offline, and put the license files next to the app
// (web/licenses/) so a deployed copy carries its notices.
import { cp, mkdir, readdir } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const src = new URL("node_modules/onnxruntime-web/dist/", root);
const dst = new URL("web/vendor/ort/", root);
await mkdir(dst, { recursive: true });
// ort.webgpu.min.mjs only ever loads the asyncify build (for the WASM and WebGPU backends alike).
const keep = (f) => f === "ort.webgpu.min.mjs" || /^ort-wasm-simd-threaded\.asyncify\.(mjs|wasm)$/.test(f);
for (const f of (await readdir(src)).filter(keep)) {
  await cp(new URL(f, src), new URL(f, dst));
  console.log("vendor/ort/" + f);
}

await mkdir(new URL("web/licenses/", root), { recursive: true });
for (const [from, to] of [["LICENSE", "LICENSE.txt"], ["NOTICE", "NOTICE.txt"], ["THIRD_PARTY_NOTICES.md", "THIRD_PARTY_NOTICES.txt"]]) {
  await cp(new URL(from, root), new URL(`web/licenses/${to}`, root));
  console.log("licenses/" + to);
}
