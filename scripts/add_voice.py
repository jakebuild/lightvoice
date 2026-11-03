"""Clone a voice from a short clip and add it to the app.

    .venv/bin/python scripts/add_voice.py CLIP.wav --name "Tên giọng" [--description "..."] [--gender Nam|Nữ] [--denoise]

Runs VieNeu-TTS v3 Nano's enrollment (speaker encoder + codec encoder +
reference encoder) on the clip and writes voices/<slug>.json: a 192-d
x-vector and 50x256 style tokens, the same layout as the built-in presets.
Then rebuilds web/models/nano.json + nano.bin and web/assets.json, so the voice
shows up in the app and returning users download only those two small files.

The clip: one speaker, 5-8 s of natural Vietnamese speech, no music or echo.
Style comes from its first 5 s. Use --denoise only for noisy recordings.
Check the result with scripts/eval_voice.py.
"""
import argparse
import json
import re
import subprocess
import sys
import unicodedata
from pathlib import Path

import soundfile as sf

ROOT = Path(__file__).resolve().parent.parent


def slug(name: str) -> str:
    ascii_name = unicodedata.normalize("NFKD", name.replace("đ", "d").replace("Đ", "D")).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-") or "voice"


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("clip")
    ap.add_argument("--name", required=True)
    ap.add_argument("--description", default="")
    ap.add_argument("--gender", default="")
    ap.add_argument("--denoise", action="store_true")
    args = ap.parse_args()

    info = sf.info(args.clip)
    if not 3.0 <= info.duration <= 30.0:
        sys.exit(f"{args.clip}: {info.duration:.1f} s; use a 5-8 s clip (3-30 s accepted)")

    from vieneu import Vieneu
    tts = Vieneu(mode="v3nano")
    if args.name in tts._preset_voices:
        sys.exit(f"'{args.name}' is already a built-in voice name")
    spk, style = tts.encode_reference(args.clip, denoise=args.denoise)

    out = ROOT / "voices" / f"{slug(args.name)}.json"
    out.parent.mkdir(exist_ok=True)
    out.write_text(json.dumps({
        "name": args.name,
        "description": args.description,
        "gender": args.gender,
        "source": Path(args.clip).name,
        "denoise": args.denoise,
        "speaker_emb": [round(float(x), 6) for x in spk.reshape(-1)],
        "style": [[round(float(x), 5) for x in row] for row in style],
    }, ensure_ascii=False), encoding="utf-8")
    print(f"{args.clip} -> {out}")
    subprocess.run([sys.executable, str(ROOT / "scripts" / "prepare_assets.py"), "--voices-only"], check=True)
    # New hashes for nano.json/nano.bin: browsers fetch just those two files again.
    subprocess.run(["node", str(ROOT / "scripts" / "manifest.mjs")], check=True)


if __name__ == "__main__":
    main()
