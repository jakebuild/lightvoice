"""Copy VieNeu-TTS v3 Nano into web/models and write golden test data.

    .venv/bin/python scripts/prepare_assets.py
    .venv/bin/python scripts/prepare_assets.py --voices-only   # just nano.json/nano.bin

Outputs:
  web/models/*.onnx           the four graphs, weights stored as fp16 (scripts/fp16_weights.py)
  web/models/nano.json        config the browser needs + voice index
  web/models/nano.bin         float32: null_spk, null_style, then each voice's spk + style
  tests/golden/*.json|.bin    Python reference results for tests/engine.test.mjs
"""
import json
import shutil
import sys
from pathlib import Path

import numpy as np
from huggingface_hub import snapshot_download

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fp16_weights  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
MODELS = ROOT / "web" / "models"
GOLDEN = ROOT / "tests" / "golden"
VOICES = ROOT / "voices"          # our own voices (scripts/add_voice.py), added after the presets
GRAPHS = ["text_encoder.onnx", "duration_predictor.onnx", "vector_estimator.onnx", "codec_decoder.onnx"]
CLONE_GRAPHS = ["speaker_encoder.onnx", "codec_encoder.onnx", "reference_encoder.onnx"]

GOLDEN_TEXTS = [
    "Xin chào, mình là giọng đọc của VieNeu Nano.",
    "Hôm nay là ngày 15/3/2025, nhiệt độ 28°C.",
    "Tôi đang dùng iPhone và mở app Facebook để xem video [cười] vui quá!",
    "Giá 3,5 triệu đồng, giảm 20% còn 2.800.000đ.\nĐoạn văn thứ hai. Thế à? Ừ.",
]


def main() -> None:
    src = Path(snapshot_download("pnnbao-ump/VieNeu-TTS-v3-Nano",
                                 allow_patterns=GRAPHS + CLONE_GRAPHS + ["config.json", "constants.npz"]))
    MODELS.mkdir(parents=True, exist_ok=True)
    if "--voices-only" in sys.argv:          # after scripts/add_voice.py: skip the graphs and golden data
        write_bundle(src)
        return
    for g in GRAPHS:
        if g == "duration_predictor.onnx":          # 0.7 MB: not worth rounding
            shutil.copyfile(src / g, MODELS / g)
        else:
            fp16_weights.convert(str(src / g), str(MODELS / g))
    # Voice cloning graphs: downloaded by the browser only when someone clones a voice.
    (MODELS / "clone").mkdir(exist_ok=True)
    for g in CLONE_GRAPHS:
        fp16_weights.convert(str(src / g), str(MODELS / "clone" / g))
    meta = write_bundle(src)
    write_golden(src, meta["default_voice"] or meta["voices"][0]["name"])
    write_golden_clone(src)
    print("models ->", MODELS)


def write_bundle(src: Path) -> dict:
    """nano.json + nano.bin: config, null conditioning, the VieNeu presets and our voices/*.json."""
    cfg = json.loads((src / "config.json").read_text(encoding="utf-8"))
    consts = np.load(src / "constants.npz")
    import vieneu
    voices = json.loads((Path(vieneu.__file__).parent / "assets" / "voices_v3_nano.json").read_text(encoding="utf-8"))
    for path in sorted(VOICES.glob("*.json")):
        v = json.loads(path.read_text(encoding="utf-8"))
        voices["presets"][v["name"]] = v

    blobs, index = [], {}
    offset = 0

    def put(arr: np.ndarray) -> list:
        nonlocal offset
        a = np.ascontiguousarray(arr, dtype=np.float32).reshape(-1)
        blobs.append(a.tobytes())
        span = [offset, int(a.size)]
        offset += int(a.size)
        return span

    index["null_spk"] = put(consts["null_spk"])
    index["null_style"] = put(consts["null_style"])
    presets = []
    for name, v in voices["presets"].items():
        presets.append({
            "name": name,
            "description": v.get("description", ""),
            "gender": v.get("gender", ""),
            "spk": put(np.asarray(v["speaker_emb"])),
            "style": put(np.asarray(v["style"])),
        })
    (MODELS / "nano.bin").write_bytes(b"".join(blobs))
    meta = {
        "sample_rate": cfg["sample_rate"],
        "flow_fps": cfg["flow_fps"],
        "latent_channels": cfg["latent_dim"] * cfg["group"],
        "n_style": cfg["n_style"],
        "style_dim": cfg["style_dim"],
        "bos_id": cfg["bos_id"], "eos_id": cfg["eos_id"], "pad_id": cfg["pad_id"],
        "vocab": cfg["vocab"],
        "emotion_tags": cfg["emotion_tags"],
        "steps_default": cfg["steps_default"],
        "cfg_default": cfg["cfg_default"],
        "tensors": index,
        # Voice cloning (web/js/clone.js, after OnnxV3NanoEngine.prepare_reference)
        "clone": {
            "latent_mean": [float(x) for x in consts["latent_mean"]],
            "latent_std": [float(x) for x in consts["latent_std"]],
            "latent_scale": float(consts["latent_scale"]),
            "group": int(cfg.get("group", 6)),
            "ref_max_frames": int(cfg.get("ref_max_frames", 140)),
            "ref_seconds": 5.0,
            "max_seconds": 30.0,
        },
        "default_voice": voices.get("default_voice"),
        "voices": presets,
    }
    (MODELS / "nano.json").write_text(json.dumps(meta, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"voices -> {MODELS / 'nano.json'}: {', '.join(p['name'] for p in presets)}")
    return meta


def write_golden(src: Path, voice: str) -> None:
    """Python reference: chunking + phonemes per text, and one engine run with fixed noise."""
    from vieneu.v3nano import OnnxV3NanoEngine
    from vieneu_utils.phonemize_text import normalize_to_chunks_v3_with_gaps, phonemize_text_with_emotions
    from vieneu import Vieneu

    GOLDEN.mkdir(parents=True, exist_ok=True)
    texts = []
    for t in GOLDEN_TEXTS:
        chunks, gaps = normalize_to_chunks_v3_with_gaps(t, max_chars=140)
        texts.append({"text": t, "chunks": chunks, "gaps": gaps,
                      "phonemes": [phonemize_text_with_emotions(c) for c in chunks]})
    (GOLDEN / "text.json").write_text(json.dumps(texts, ensure_ascii=False, indent=1), encoding="utf-8")

    # Engine run with noise we hand to JS, so the two are comparable sample for sample.
    eng = OnnxV3NanoEngine(local_dir=str(src))
    tts = Vieneu(mode="v3nano", onnx_dir=str(src))
    v = tts.get_preset_voice(voice)
    ph = texts[0]["phonemes"][0]
    ids = eng.encode_phones(ph)
    mask = ids != eng.pad
    style = v["style"].reshape(1, *v["style"].shape[-2:]).astype(np.float32)
    spk = v["speaker_emb"].reshape(1, -1).astype(np.float32)
    ctx = eng.s_text.run(None, {"ids": ids, "style": style})[0]
    log_s = float(eng.s_dur.run(None, {"ctx": ctx, "ctx_mask": mask, "spk": spk})[0][0])
    T = max(2, int(round(min(np.exp(log_s), 15.0) * eng.fps)))
    noise = np.random.default_rng(0).standard_normal((1, 144, T)).astype(np.float32)
    steps, cfg = 8, 3.0

    # Same loop as OnnxV3NanoEngine.infer, starting from `noise`.
    x = noise.copy()
    tg = np.linspace(0.0, 1.0, steps + 1, dtype=np.float64)
    for i in range(steps):
        t = np.array([tg[i]], dtype=np.float32)
        vc = eng.s_ve.run(None, {"x": x, "t": t, "ctx": ctx, "ctx_mask": mask, "spk": spk, "style": style})[0]
        vu = eng.s_ve.run(None, {"x": x, "t": t, "ctx": eng._null_ctx, "ctx_mask": eng._null_mask,
                                 "spk": eng.null_spk, "style": eng.null_style})[0]
        x = x + np.float32(tg[i + 1] - tg[i]) * (vu + cfg * (vc - vu))
    wav = eng.s_dec.run(None, {"x": x})[0][0, 0].astype(np.float32)

    (GOLDEN / "engine.json").write_text(json.dumps({
        "fp32_snapshot": src.name, "voice": voice, "phonemes": ph, "ids": ids[0].tolist(), "log_seconds": log_s, "frames": T,
        "steps": steps, "cfg": cfg, "wav_samples": int(wav.size),
    }, ensure_ascii=False, indent=1), encoding="utf-8")
    (GOLDEN / "noise.bin").write_bytes(noise.tobytes())
    (GOLDEN / "wav.bin").write_bytes(wav.tobytes())
    import soundfile as sf
    sf.write(GOLDEN / "python.wav", wav, 24000)


def write_golden_clone(src: Path) -> None:
    """Python reference for voice cloning, stage by stage, for tests/clone.test.mjs.

    The input clip is made with a preset voice, so the test needs no recording of
    a real person. It is 24 kHz, the rate the browser decodes clips to; the
    16 kHz copy for the speaker encoder is resampled here with soxr, as Python does.
    """
    import librosa
    from vieneu import Vieneu
    from vieneu._v3_turbo_engine.speaker.audio_utils import high_quality_resample
    from vieneu._v3_turbo_engine.speaker.fbank import extract_speaker_fbank

    tts = Vieneu(mode="v3nano", onnx_dir=str(src))
    clip = tts.infer("Xin chào, mình đang thử tính năng nhân bản giọng nói ngay trong trình duyệt. "
                     "Giọng này sẽ được dùng để đọc mọi văn bản.", voice="Ái Hân", seed=3, apply_watermark=False)
    clip = np.concatenate([np.zeros(6000, np.float32), clip, np.zeros(9000, np.float32)])  # silence to trim
    sr = 24000
    trimmed, _ = librosa.effects.trim(clip, top_db=30)                 # V3TurboVieNeuTTS._preclean_reference_audio
    eng = tts.engine
    eng._ensure_clone_sessions()
    wav16 = high_quality_resample(trimmed, sr, 16000)
    fbank = extract_speaker_fbank(wav16, sample_rate=16000)
    spk = eng.speaker_encoder.embed_fbank(fbank)
    m24 = trimmed[: int(sr * 5.0)]
    mu = eng.s_codec_enc.run(None, {"wav": m24[None, None]})[0]
    spk_full, style = eng.prepare_reference(trimmed, sr=sr, denoise=False)   # the real entry point
    assert np.allclose(spk_full, eng.speaker_encoder.embed(trimmed, sr), atol=1e-5)

    GOLDEN.mkdir(parents=True, exist_ok=True)
    for name, arr in {"clip24": clip, "wav16": wav16, "fbank": fbank, "spk": spk_full, "mu": mu, "style": style}.items():
        (GOLDEN / f"clone_{name}.bin").write_bytes(np.ascontiguousarray(arr, dtype=np.float32).tobytes())
    (GOLDEN / "clone.json").write_text(json.dumps({
        "clip_samples": int(clip.size), "trimmed_samples": int(trimmed.size), "wav16_samples": int(wav16.size),
        "fbank_shape": list(fbank.shape), "mu_shape": list(mu.shape), "style_shape": list(style.shape),
        "spk_from_soxr_fbank_cos": float(np.dot(spk, spk_full) / np.linalg.norm(spk) / np.linalg.norm(spk_full)),
        "fp32_snapshot": src.name,
    }, indent=1), encoding="utf-8")


if __name__ == "__main__":
    sys.exit(main())
