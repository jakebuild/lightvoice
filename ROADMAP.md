# Roadmap

Each item is a GitHub issue with a goal, context, testable acceptance criteria
and dependencies. Issues labelled **`agent-ready`** are specified tightly enough
for a coding agent to build unattended: a nightly run picks the lowest-numbered
one whose dependencies are closed and opens a pull request (see
[`AGENTS.md`](AGENTS.md)). Issues labelled **`needs-human`** need a person:
real devices, listening, or decisions. Contributions from people are just as
welcome: comment on an issue to claim it.

Tick an item in the pull request that completes it.

## Phase 1: Foundations

- [ ] [#1](https://github.com/jakebuild/lightvoice/issues/1) Browser end-to-end tests with Playwright
- [ ] [#2](https://github.com/jakebuild/lightvoice/issues/2) Larger golden corpus for text normalization and chunking
- [ ] [#3](https://github.com/jakebuild/lightvoice/issues/3) Port number-aware splitting of long unpunctuated sentences (after #2)
- [ ] [#4](https://github.com/jakebuild/lightvoice/issues/4) Streaming playback: start speaking after the first chunk (after #1)
- [ ] [#5](https://github.com/jakebuild/lightvoice/issues/5) Installable app: icons, manifest, iOS "Add to Home Screen" hint
- [ ] [#6](https://github.com/jakebuild/lightvoice/issues/6) Benchmark and diagnostics page for device reports
- [ ] [#18](https://github.com/jakebuild/lightvoice/issues/18) 🙋 Test on real phones (after #6)
- [ ] [#19](https://github.com/jakebuild/lightvoice/issues/19) 🙋 Measure WebGPU on machines with a GPU (after #6)

## Phase 2: Product

- [ ] [#7](https://github.com/jakebuild/lightvoice/issues/7) Subtitle export, SRT and WebVTT (after #4)
- [ ] [#8](https://github.com/jakebuild/lightvoice/issues/8) Export and import cloned voices as files
- [ ] [#9](https://github.com/jakebuild/lightvoice/issues/9) Voice blending: new voices from two voices (after #8)
- [ ] [#10](https://github.com/jakebuild/lightvoice/issues/10) Lock-screen controls and background playback (after #4)
- [ ] [#11](https://github.com/jakebuild/lightvoice/issues/11) Reader mode: text files, chapter by chapter (after #4)
- [ ] [#12](https://github.com/jakebuild/lightvoice/issues/12) Reader: generate ahead, cache audio, remember position (after #11)
- [ ] [#13](https://github.com/jakebuild/lightvoice/issues/13) Reader: EPUB import (after #11)
- [ ] [#14](https://github.com/jakebuild/lightvoice/issues/14) Optional denoiser for voice cloning
- [ ] [#20](https://github.com/jakebuild/lightvoice/issues/20) 🙋 Listening test of long-form quality with native speakers

## Phase 3: Platform

- [ ] [#15](https://github.com/jakebuild/lightvoice/issues/15) Embeddable JavaScript API (after #4)
- [ ] [#16](https://github.com/jakebuild/lightvoice/issues/16) `<light-voice>` web component (after #15)
- [ ] [#17](https://github.com/jakebuild/lightvoice/issues/17) Experiment: int8 weights to halve the download again

🙋 = needs a human.

## Later, not yet specified

- Native iOS app using the same ONNX graphs (shipping and storage decisions first).
- High-quality mode: VieNeu-TTS v3 Turbo (48 kHz) on WebGPU, if #19 shows the headroom.
- Speech-to-text for a full voice loop.
