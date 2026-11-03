"""Score a cloned voice: how much it sounds like the reference, and how intelligible it is.

    .venv/bin/python scripts/eval_voice.py REF.wav [--compare PRESET ...] [--out DIR]

For each voice (the clone of REF.wav, plus any presets to compare against) it
synthesizes the same test sentences with v3 Nano and reports:

  similarity  cosine between the x-vector of the output and of REF.wav
              (VieNeu's own speaker encoder; same speaker ~0.75+, different ~<0.5)
  CER         character error rate of faster-whisper's transcript vs the input,
              after stripping case and punctuation (lower = clearer speech)

WAVs go to --out so they can be listened to; numbers don't replace listening.
"""
import argparse
import re
import unicodedata
from pathlib import Path

import librosa
import numpy as np
import soundfile as sf

SENTENCES = [
    "Xin chào cả nhà, hôm nay mình sẽ hướng dẫn các bạn nấu món phở bò thật ngon.",
    # No numbers: the recognizer writes them as digits, which CER would count as errors.
    "Sản phẩm đang giảm giá rất mạnh, mua ngay kẻo lỡ nhé!",
    "Thời tiết ở Hà Nội tuần này khá lạnh, các bạn nhớ mặc ấm khi ra ngoài.",
    "Bạn đã bao giờ tự hỏi tại sao bầu trời lại có màu xanh chưa?",
]


def norm(s: str) -> str:
    s = unicodedata.normalize("NFC", s.lower())
    return " ".join(re.sub(r"[^\w\s]", "", s).split())


def cer(ref: str, hyp: str) -> float:
    r, h = norm(ref), norm(hyp)
    d = list(range(len(h) + 1))
    for i, rc in enumerate(r, 1):
        prev, d[0] = d[0], i
        for j, hc in enumerate(h, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (rc != hc))
    return d[len(h)] / max(1, len(r))


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("ref")
    ap.add_argument("--compare", nargs="*", default=[])
    ap.add_argument("--out", default="ref/eval")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()

    from faster_whisper import WhisperModel
    from vieneu import Vieneu

    tts = Vieneu(mode="v3nano")
    asr = WhisperModel("small", device="cpu", compute_type="int8")
    spk_enc = tts.engine.speaker_encoder if hasattr(tts.engine, "speaker_encoder") else None
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    spk, style = tts.encode_reference(args.ref, denoise=False)
    voices = {"clone": {"speaker_emb": spk, "style": style}}
    for name in args.compare:
        voices[name] = tts.get_preset_voice(name)

    tts.engine._ensure_clone_sessions()
    spk_enc = tts.engine.speaker_encoder
    ref_wav, ref_sr = sf.read(args.ref, dtype="float32")
    ref_x = spk_enc.embed(ref_wav, ref_sr)
    cos = lambda a, b: float(np.dot(a, b) / np.linalg.norm(a) / np.linalg.norm(b))

    print(f"{'voice':12s} {'similarity':>10s} {'CER':>6s}")
    for name, v in voices.items():
        sims, cers = [], []
        for i, text in enumerate(SENTENCES):
            wav = tts.infer(text, voice=v, seed=args.seed + i, apply_watermark=False)
            sf.write(out / f"{name}_{i}.wav", wav, tts.sample_rate)
            sims.append(cos(spk_enc.embed(wav, tts.sample_rate), ref_x))
            segs, _ = asr.transcribe(librosa.resample(wav, orig_sr=tts.sample_rate, target_sr=16000),
                                     language="vi", beam_size=5)
            hyp = " ".join(s.text.strip() for s in segs)
            cers.append(cer(text, hyp))
            if cers[-1] > 0.1:
                print(f"  {name}_{i}: '{hyp}'")
        print(f"{name:12s} {np.mean(sims):10.2f} {np.mean(cers):6.1%}")


if __name__ == "__main__":
    main()
