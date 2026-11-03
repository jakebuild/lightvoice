# LightVoice

**English** · [Tiếng Việt](README.vi.md)

**Live demo: https://lightvoice.jakesale.workers.dev**

Vietnamese text-to-speech that runs entirely in the browser and works offline:
[VieNeu-TTS v3 Nano](https://github.com/pnnbao97/VieNeu-TTS) (48M-parameter flow-matching
model, Apache-2.0) on onnxruntime-web, with the [sea-g2p](https://github.com/pnnbao97/sea-g2p)
Vietnamese normalizer/phonemizer compiled to WebAssembly.

Speak Vietnamese text with 11 preset voices, or clone your own voice from a
5–10 second recording. After the first visit (~190 MB download) it works with
no network, and nothing you type or record leaves the device.

## Setup

Needs Python 3.12 with [uv](https://docs.astral.sh/uv/), Node 20+, and Rust
with the `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`).
The model, runtime and phonemizer are built locally and not committed.

```bash
uv venv .venv && uv pip install --python .venv/bin/python vieneu onnx
npm install
.venv/bin/python scripts/prepare_assets.py   # model -> web/models, golden test data -> tests/golden
npm run vendor                               # onnxruntime-web runtime -> web/vendor/ort
npm run build:g2p                            # sea-g2p -> web/g2p (needs Rust + wasm32 target)
npm run manifest                             # file sizes -> web/assets.json (storage status)
npm test                                     # browser code vs the Python reference
npm run serve                                # http://localhost:8080
```

`serve` sends COOP/COEP headers; without cross-origin isolation onnxruntime-web
falls back to one WASM thread. Any static host works if it sends the same headers.

## Deploy

```bash
npm run build            # web/ -> dist/: files over 20 MiB split into parts, _headers written
npx wrangler deploy      # Cloudflare Workers static assets (wrangler.jsonc), no Worker script
```

Cloudflare rejects files over 25 MiB, so `scripts/build_dist.mjs` splits the
large graphs and onnxruntime's WASM into `.partN` files; the worker fetches the
parts and caches the joined file. `node scripts/serve.mjs 8081 dist` serves the
build locally the same way.

## Adding a voice

```bash
.venv/bin/python scripts/add_voice.py clip.wav --name "Tên giọng" --description "Nam · Nam · ..."
uv pip install --python .venv/bin/python faster-whisper                 # for eval_voice.py
.venv/bin/python scripts/eval_voice.py clip.wav --compare Adam   # similarity + intelligibility
```

A voice is a 192-d speaker embedding plus 50×256 style tokens computed from a
5–8 s clip (one speaker, clean, Vietnamese); no training involved. It is saved
to `voices/<slug>.json` and merged into `web/models/nano.bin` (~50 KB per voice).
Only clone voices you have the rights to.

`eval_voice.py` reports speaker similarity to the clip (same speaker ≈ 0.75+)
and the character error rate of a Whisper transcript. Listen to the WAVs it
writes to `ref/eval/` too.

## Cloning in the browser

Users can record or upload a 5–10 s clip and get their own voice, made on the
device and kept in that browser (`lightvoice-user-voices-v1` in Cache Storage).
The three enrollment graphs (`web/models/clone/`, 48 MB with fp16 weights) are
downloaded only on the first clone. The page decodes the clip at 24 kHz and
renders a 16 kHz copy with `OfflineAudioContext`; `web/js/clone.js` ports the
silence trim, the Kaldi fbank and `prepare_reference` (`tests/clone.test.mjs`
checks each stage against Python).

## How it fits together

| Piece | File | Python original |
| --- | --- | --- |
| Flow sampler + 4 ONNX graphs | `web/js/engine.js` | `vieneu/v3nano.py` |
| Sentence split, chunking, emotion cues | `web/js/text.js` | `vieneu_utils/phonemize_text.py`, `core_utils.py` |
| Trim/fade, chunk joins, WAV | `web/js/audio.js` | `vieneu_utils/core_utils.py` |
| Normalize + G2P | `web/g2p/` (WASM) | `sea_g2p` (same Rust code) |
| Inference off the main thread | `web/js/worker.js` | |
| Offline shell | `web/sw.js` | |

The worker keeps the model and dictionary in Cache Storage (`MODEL_CACHE` in
`web/js/config.js`), so after the first load nothing touches the network. Each
file is cached as `path?v=<content hash>` from `web/assets.json`
(`npm run manifest`), so changing one file — a new voice changes only
`nano.json`/`nano.bin` — re-downloads just that file, and the stale copy is
deleted after the next successful load. After loading, the page asks for persistent storage
(`navigator.storage.persist()`) and shows whether the files are on the device
and whether the browser has agreed to keep them (`web/js/storage.js`).

The shipped graphs store their weights as fp16 and compute in fp32
(`scripts/fp16_weights.py`): half the download, same speed, no fp16 kernels
needed. Against the original graphs the audio differs ~100× less than two takes
with different seeds do.

`npm run build:g2p` fetches upstream sea-g2p at a pinned commit into
`vendor/sea-g2p` and applies `vendor/sea-g2p-lightvoice.patch`: the dictionary
can load from bytes instead of an mmap'd file, and a `wasm` feature exports
`SeaG2p` through wasm-bindgen (`src/wasm.rs`).

## Known gaps

- An over-long sentence with no punctuation is split evenly by word; Python's
  splitter also avoids cutting inside spoken numbers.
- In-browser cloning skips VieNeu's optional denoiser (43 MB), so a noisy
  recording makes a noisier voice. Uploading a clip is tested end to end; the
  microphone path (MediaRecorder) has not been tested on a real device yet.
- First load is ~190 MB: 136 MB of graphs (fp16 weights barely compress), a
  15 MB gzipped dictionary (Vietnamese/English only, 50 MB once inflated;
  `scripts/strip_dict.py`), 29 MB of onnxruntime WASM and 4 MB of sea-g2p WASM.
  The onnxruntime WASM ships as split parts, so hosts don't compress it; it
  would gzip to ~7 MB.
- Safari clears script-written storage after 7 days without a visit unless the
  app is added to the home screen; the page doesn't prompt for that yet.

## Responsible use

Only clone voices you have the right to use, never to impersonate, defraud or
deceive, and say that speech is synthetic where listeners would expect to know.
This follows the VieNeu-TTS model card.

## License

Apache-2.0, see `LICENSE`. The model weights, preset voices and sea-g2p are
Apache-2.0 works by Pham Nguyen Ngoc Bao; ONNX Runtime Web is MIT. See `NOTICE`
for attribution and the changes made to them, and `THIRD_PARTY_NOTICES.md` for
the full list. The VieNeu-TTS model card permits commercial use of the preset
voices and generated audio.
