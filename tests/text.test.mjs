// sea-g2p WASM + web/js/text.js against the Python pipeline
// (normalize_to_chunks_v3_with_gaps + phonemize_text_with_emotions).
// Skipped until scripts/build_g2p.sh has produced web/g2p.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { textToChunks, phonemizeChunk } from "../web/js/text.js";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root));
const built = await access(new URL("web/g2p/sea_g2p_rs.js", root)).then(() => true, () => false);

test("chunks and phonemes match Python", { skip: !built && "web/g2p not built (scripts/build_g2p.sh)" }, async () => {
  const { default: init, SeaG2p, punc_norm } = await import("../web/g2p/sea_g2p_rs.js");
  await init({ module_or_path: await read("web/g2p/sea_g2p_rs_bg.wasm") });
  // The shipped dictionary: Vietnamese/English only, gzipped (scripts/build_g2p.sh).
  const sea = new SeaG2p(new Uint8Array(gunzipSync(await read("web/g2p/sea_g2p.bin.gz"))));
  const g2p = { normalize: (t, p) => sea.normalize(t, p), phonemize: (t, p) => sea.phonemize(t, p), puncNorm: punc_norm };

  for (const g of JSON.parse(await read("tests/golden/text.json"))) {
    const { chunks, gaps } = textToChunks(g2p, g.text);
    assert.deepEqual(chunks, g.chunks, g.text);
    assert.deepEqual(gaps, g.gaps, g.text);
    assert.deepEqual(chunks.map((c) => phonemizeChunk(g2p, c)), g.phonemes, g.text);
  }
});
