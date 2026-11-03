# Third-party notices

LightVoice is Apache-2.0 (see `LICENSE` and `NOTICE`). A built copy of the web
app (`web/` after the setup steps in `README.md`) also contains the works below.

| Component | Where it ends up | License |
| --- | --- | --- |
| [VieNeu-TTS v3 Nano](https://huggingface.co/pnnbao-ump/VieNeu-TTS-v3-Nano) model weights, config and 11 preset voices, by Pham Nguyen Ngoc Bao | `web/models/` (converted, see `NOTICE`) | Apache-2.0 |
| [vieneu](https://github.com/pnnbao97/VieNeu-TTS) Python package (algorithms reimplemented in `web/js/`) | `web/js/engine.js`, `text.js`, `audio.js`, `clone.js` | Apache-2.0 |
| [sea-g2p](https://github.com/pnnbao97/sea-g2p), by Pham Nguyen Ngoc Bao | `web/g2p/` (patched, see `NOTICE`) | Apache-2.0 |
| [ONNX Runtime Web](https://github.com/microsoft/onnxruntime), Microsoft | `web/vendor/ort/` | MIT |
| [wasm-bindgen](https://github.com/rustwasm/wasm-bindgen) glue code | `web/g2p/sea_g2p_rs.js` | MIT or Apache-2.0 |
| Rust crates compiled into `sea_g2p_rs_bg.wasm`: regex, fancy-regex, once_cell, rayon, unicode-normalization, wasm-bindgen and their dependencies | `web/g2p/` | MIT or Apache-2.0 |

## Usage notes from the model authors

The VieNeu-TTS v3 Nano model card states that the preset voices and audio
generated with them may be used commercially, and that the preset speakers
consented to synthetic speech. It also asks users to:

> Only clone voices you have the right to use. Do not use it to impersonate,
> defraud, or deceive, and disclose synthetic speech where your audience would
> reasonably expect to know.

The model's training data (VieNeu-TTS-1000h) is published separately under
CC-BY-NC-4.0 and is not part of this repository.

## MIT License (ONNX Runtime Web)

```
MIT License

Copyright (c) Microsoft Corporation

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
