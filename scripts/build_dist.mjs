// Build dist/ for static hosting (Cloudflare Pages): a copy of web/ where every
// model-cache file over PART_BYTES is split into `<path>.part<N>` pieces, which
// the worker fetches and joins (Pages rejects files over 25 MiB). Also writes
// _headers: cross-origin isolation for multi-threaded WASM, and cache rules.
//
//   npm run manifest && node scripts/build_dist.mjs
import { cp, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const web = new URL("web/", root);
const dist = new URL("dist/", root);
const PART_BYTES = 20 * 1024 * 1024;

await rm(dist, { recursive: true, force: true });
await cp(web, dist, { recursive: true });

const manifest = JSON.parse(await readFile(new URL("assets.json", web), "utf8"));
for (const f of manifest.files) {
  if (f.cache !== "models" || f.bytes <= PART_BYTES) continue;
  const bytes = await readFile(new URL(f.path, web));
  f.parts = Math.ceil(bytes.length / PART_BYTES);
  for (let i = 0; i < f.parts; i++) {
    await writeFile(new URL(`${f.path}.part${i}`, dist), bytes.subarray(i * PART_BYTES, (i + 1) * PART_BYTES));
  }
  await rm(new URL(f.path, dist));
  console.log(`${f.path}: ${(f.bytes / 1e6).toFixed(1)} MB -> ${f.parts} parts`);
}
await writeFile(new URL("assets.json", dist), JSON.stringify(manifest, null, 1) + "\n");

await writeFile(new URL("_headers", dist), `/*
  Cross-Origin-Opener-Policy: same-origin
  Cross-Origin-Embedder-Policy: require-corp
  X-Content-Type-Options: nosniff

# Model files are fetched as ?v=<content hash> and kept in Cache Storage by the worker.
/models/*
  Cache-Control: public, max-age=31536000, immutable
/g2p/*
  Cache-Control: public, max-age=31536000, immutable
/vendor/*
  Cache-Control: public, max-age=31536000, immutable
`);

// Pages' 25 MiB per-file limit: fail the build here rather than at upload.
const { readdir, stat } = await import("node:fs/promises");
const tooBig = [];
for (const f of await readdir(dist, { recursive: true })) {
  const s = await stat(new URL(f, dist));
  if (s.isFile() && s.size > 25 * 1024 * 1024) tooBig.push(`${f} (${(s.size / 1e6).toFixed(1)} MB)`);
}
if (tooBig.length) throw new Error(`over 25 MiB: ${tooBig.join(", ")}`);
console.log("dist/ ready");
