# Working on LightVoice (instructions for coding agents)

LightVoice is Vietnamese text-to-speech that runs entirely in the browser and
works offline. Read `README.md` first for how the pieces fit. This file is the
contract for unattended work, including the nightly agent run
(`.github/agent/nightly.md`).

## Picking work

1. Work comes from GitHub issues labelled **`agent-ready`**, one issue per run.
2. Take the lowest-numbered open `agent-ready` issue that:
   - has no open pull request linked to it (search `is:pr is:open <number>`),
   - is not labelled `blocked`, `needs-human` or `in-progress`,
   - has every issue listed under "Depends on" closed.
3. Label it `in-progress` and comment that you started. If nothing qualifies,
   stop and do nothing.

## Doing the work

- Branch `agent/<issue>-<short-slug>` from the latest `main`.
- Do what the issue's **Acceptance** section asks, and nothing outside its
  **Out of scope**. Small, reviewable pull requests: if the issue turns out to
  be bigger than one PR, do the first coherent slice and say what remains.
- Every change ships with tests that would fail without it. Ports of the
  Python reference (`vieneu`, `sea-g2p`) are tested against golden data the
  Python code writes (`scripts/prepare_assets.py`), the way `tests/*.test.mjs`
  already are.
- Run the full check before opening the PR:
  ```bash
  npm run manifest && npm test && npm run build
  ```
  Set the environment up as in `README.md` if it is missing.
- Update `ROADMAP.md`: tick the item and link the PR.
- Open a pull request that says `Closes #<issue>`, what changed, how it was
  verified (commands and their results), and anything left for a human
  (listening, real devices). Then remove `in-progress` from the issue.

## If you get stuck

Comment on the issue with what you tried, what failed (exact errors) and what
a person needs to decide, label it `needs-human`, remove `in-progress`, and
stop. Do not open a half-working PR to have something to show.

## Hard rules

- **Never push to `main`, merge, tag, release or deploy.** Humans merge;
  deploys (`npx wrangler deploy`) are manual.
- **Never commit** model files, `web/models/`, `dist/`, `vendor/sea-g2p/`,
  `.venv/`, `node_modules/`, or any audio of a real person. Test audio is made
  with the preset voices (see `write_golden_clone`).
- **Licensing:** new dependencies must be MIT, BSD, Apache-2.0 or similarly
  permissive, and get a line in `THIRD_PARTY_NOTICES.md` (and `NOTICE` if they
  ship in `web/`). Never change the license of the project or remove
  attribution to VieNeu-TTS / sea-g2p.
- **Offline-first:** nothing in `web/` may load from a CDN or call a server at
  run time. New runtime files go through `scripts/manifest.mjs` so they are
  cached and versioned.
- **Download size:** do not grow the core first-load download (see
  `web/assets.json`, files without `optional`) without stating the size change
  in the PR. Optional features download on first use, like voice cloning.
- **Voice consent stays:** cloning keeps the "my own voice or I have
  permission" checkbox and the synthetic-speech notice in the footer.
- **Python parity:** do not change audio output for the same input unless the
  issue asks for it; the engine tests compare against Python.
- Don't edit `.github/workflows/` or this file unless the issue is about them.

## Conventions

- Plain ES modules, no bundler, no framework. Match the surrounding style:
  short comments that say why, not what.
- Browser code lives in `web/js/`; Node build tooling in `scripts/*.mjs`;
  Python reference tooling in `scripts/*.py` (pinned in `requirements.txt`).
- Tests use `node:test` in `tests/*.test.mjs`. Anything that needs the model
  loads it from `web/models/` built by `prepare_assets.py`.
- The worker (`web/js/worker.js`) owns all model work; the page
  (`web/js/app.js`) only does UI and audio I/O. Keep the main thread free.
- Bump `SHELL` in `web/sw.js` when you add a file to `SHELL_FILES`.
