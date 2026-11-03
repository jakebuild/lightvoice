// Where huggingface_hub keeps the original (fp32) VieNeu-TTS v3 Nano snapshot
// that scripts/prepare_assets.py downloaded. Tests against the original graphs
// skip when it isn't there (they need `prepare_assets.py` to have run locally).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function nanoSnapshot(revision) {
  const hub = process.env.HF_HUB_CACHE
    ?? (process.env.HF_HOME ? join(process.env.HF_HOME, "hub") : join(homedir(), ".cache", "huggingface", "hub"));
  const dir = join(hub, "models--pnnbao-ump--VieNeu-TTS-v3-Nano", "snapshots", revision);
  return existsSync(dir) ? dir : null;
}
