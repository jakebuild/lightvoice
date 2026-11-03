import { encodeWav } from "./audio.js";
import { storageStatus, requestPersist, describe, mb } from "./storage.js";
import { trimSilence } from "./clone.js";
import { listVoices, saveVoice, deleteVoice, decodeClip } from "./voices.js";

const $ = (id) => document.getElementById(id);
const worker = new Worker(new URL("./worker.js", import.meta.url), { type: "module" });
const files = {};
const USER = "user:"; // voice <select> values for cloned voices
const userVoices = new Map();
let jobId = 0;
let lastUrl = null;
let clip = null; // { wav24, wav16, seconds, peak, url } waiting to become a voice
let cloneJob = null; // id of the pending clone request

if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
// navigator.gpu can exist with no usable adapter (e.g. Chrome on Linux without GPU flags).
const gpuAdapter = navigator.gpu ? await navigator.gpu.requestAdapter().catch(() => null) : null;
if (!gpuAdapter) {
  $("backend").value = "wasm";
  $("backend").querySelector('[value="webgpu"]').disabled = true;
}
$("env").textContent = [
  gpuAdapter ? "WebGPU available" : "No WebGPU adapter",
  self.crossOriginIsolated ? "multi-threaded WASM" : "single-threaded WASM (page is not cross-origin isolated)",
].join(" · ");

let cloneBytes = 0;
let cloneSaved = false;

async function showStorage() {
  try {
    const s = await storageStatus();
    $("storage").textContent = describe(s);
    cloneBytes = s.clone.bytes;
    cloneSaved = s.clone.saved;
    if (s.savedBytes >= s.totalBytes) $("load").textContent = "Load model";
    else if (s.modelBytesSaved === 0) $("load").textContent = "Download model";
    else $("load").textContent = s.totalBytes - s.savedBytes < 5e6 ? "Update and load" : "Resume download";
  } catch (e) {
    $("storage").textContent = `Can't read browser storage (${e.message}). The model may download on every visit.`;
  }
}
showStorage();

$("load").onclick = () => {
  $("load").disabled = true;
  $("backend").disabled = true;
  $("progress").hidden = false;
  worker.postMessage({ type: "init", backend: $("backend").value });
};

function speak(text, voiceValue) {
  $("speak").disabled = true;
  $("phonemes").textContent = "";
  const seed = $("seed").value === "" ? undefined : Number($("seed").value);
  const voice = voiceValue.startsWith(USER) ? userVoices.get(voiceValue.slice(USER.length)) : voiceValue;
  worker.postMessage({
    type: "synth",
    id: ++jobId,
    text,
    voice: typeof voice === "string" ? voice : { spk: voice.spk, style: voice.style },
    steps: Number($("steps").value),
    cfg: 3.0,
    speed: Number($("speed").value),
    seed,
  });
}

$("speak").onclick = () => {
  const text = $("text").value.trim();
  if (text) speak(text, $("voice").value);
};

// ── Your voices ───────────────────────────────────────────────────────────────

function renderUserVoices(selectId) {
  $("voice").querySelector("optgroup")?.remove();
  $("my-voices").replaceChildren();
  if (!userVoices.size) return;
  const group = document.createElement("optgroup");
  group.label = "Your voices";
  for (const v of userVoices.values()) {
    group.append(new Option(v.name, USER + v.id));
    const row = document.createElement("div");
    row.className = "voice-item";
    const label = document.createElement("span");
    label.textContent = v.name;
    const del = document.createElement("button");
    del.textContent = "Delete";
    del.onclick = async () => {
      if (!confirm(`Delete the voice "${v.name}"?`)) return;
      await deleteVoice(v.id);
      userVoices.delete(v.id);
      renderUserVoices();
    };
    row.append(label, del);
    $("my-voices").append(row);
  }
  $("voice").append(group);
  if (selectId) $("voice").value = USER + selectId;
}

function updateCreateButton() {
  $("create-voice").disabled = !(clip && $("consent").checked && $("clone-name").value.trim()) || cloneJob !== null;
}
$("consent").onchange = updateCreateButton;
$("clone-name").oninput = updateCreateButton;

async function useClip(blob) {
  $("clip-status").textContent = "Reading the clip…";
  $("clone-form").hidden = true;
  try {
    const c = await decodeClip(blob, trimSilence);
    if (c.seconds < 3) throw new Error(`Only ${c.seconds.toFixed(1)} s of speech found. Record at least 5 seconds.`);
    const notes = [];
    if (c.peak < 0.05) notes.push("it's very quiet, so move closer to the mic");
    if (c.peak > 0.99) notes.push("it may be clipping, so move back a little");
    if (c.seconds > 30) notes.push("only the first 30 seconds are used");
    if (clip?.url) URL.revokeObjectURL(clip.url);
    clip = { ...c, url: URL.createObjectURL(blob) };
    $("clip-player").src = clip.url;
    $("clip-player").hidden = false;
    $("clip-status").textContent = `${c.seconds.toFixed(1)} s of speech${notes.length ? `. Note: ${notes.join("; ")}.` : "."}`;
    $("clone-form").hidden = false;
    $("clone-status").textContent = cloneSaved ? "" : `Creating the first voice downloads ${mb(cloneBytes)} once.`;
    updateCreateButton();
  } catch (e) {
    clip = null;
    $("clip-status").textContent = e.message.startsWith("Only") ? e.message : `Couldn't read that audio (${e.message}).`;
  }
}

$("upload").onchange = (e) => {
  const f = e.target.files[0];
  if (f) useClip(f);
  e.target.value = "";
};

let recorder = null;
let recordTimer = null;
$("record").onclick = async () => {
  if (recorder) {
    recorder.stop();
    return;
  }
  let stream;
  try {
    // Keep the voice as it is; noise suppression only takes the edge off room noise.
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, autoGainControl: false, noiseSuppression: true } });
  } catch (e) {
    $("clip-status").textContent = `No microphone access (${e.message}).`;
    return;
  }
  const chunks = [];
  recorder = new MediaRecorder(stream);
  recorder.ondataavailable = (e) => chunks.push(e.data);
  recorder.onstop = () => {
    clearInterval(recordTimer);
    stream.getTracks().forEach((t) => t.stop());
    $("record").textContent = "Record again";
    $("record").classList.remove("recording");
    recorder = null;
    useClip(new Blob(chunks, { type: chunks[0]?.type || "audio/webm" }));
  };
  const started = Date.now();
  recorder.start();
  $("record").textContent = "Stop";
  $("record").classList.add("recording");
  recordTimer = setInterval(() => {
    const s = (Date.now() - started) / 1000;
    $("clip-status").textContent = `Recording… ${s.toFixed(0)} s${s < 5 ? " (keep going)" : ""}`;
    if (s >= 15) recorder?.stop();
  }, 250);
};

$("create-voice").onclick = () => {
  cloneJob = ++jobId;
  updateCreateButton();
  $("clone-status").textContent = cloneSaved ? "Analysing the voice…" : `Downloading voice cloning (${mb(cloneBytes)}, once)…`;
  // Copies: the clip stays usable if the user wants to try again.
  worker.postMessage({ type: "clone", id: cloneJob, wav24: clip.wav24.slice(), wav16: clip.wav16.slice() });
};

async function onCloned({ spk, style, ms }) {
  const voice = await saveVoice({ name: $("clone-name").value.trim(), spk, style });
  userVoices.set(voice.id, voice);
  renderUserVoices(voice.id);
  cloneJob = null;
  cloneSaved = true;
  $("clone-status").textContent = `Created "${voice.name}" in ${(ms / 1000).toFixed(1)} s. It's selected above. Playing a preview…`;
  $("clone-name").value = "";
  $("consent").checked = false;
  updateCreateButton();
  requestPersist().catch(() => false).then(showStorage);
  speak("Xin chào, đây là giọng đọc mới của bạn. Bạn có thể dùng nó để đọc bất kỳ văn bản nào.", USER + voice.id);
}

// ── Worker messages ───────────────────────────────────────────────────────────

function showProgress({ stage, file, loaded, total }) {
  if (stage === "download") {
    files[file] = { loaded, total };
    const all = Object.values(files);
    const got = all.reduce((n, f) => n + f.loaded, 0);
    const want = all.reduce((n, f) => n + f.total, 0);
    $("bar-fill").style.width = want ? `${(100 * got) / want}%` : "0";
    // Cloning downloads after the model is ready: report it in the clone card only.
    if (cloneJob !== null) $("clone-status").textContent = `Downloading voice cloning: ${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB (${file})`;
    else $("progress-text").textContent = `Downloading ${file} (${(got / 1e6).toFixed(0)} / ${(want / 1e6).toFixed(0)} MB)`;
  } else if (stage === "cached") {
    if (cloneJob === null) $("progress-text").textContent = `Loaded ${file} from the offline cache`;
  } else if (stage === "compile") {
    if (file !== "clone") $("bar-fill").style.width = "100%";
    if (file === "clone") $("clone-status").textContent = "Analysing the voice…";
    else $("progress-text").textContent = file === "onnx" ? "Preparing the model…" : "Preparing the phonemizer…";
  }
}

worker.onmessage = async ({ data }) => {
  switch (data.type) {
    case "progress":
      showProgress(data);
      break;
    case "ready": {
      $("progress-text").textContent = `Ready on ${data.backend.toUpperCase()}${data.backend === "wasm" ? ` (${data.threads} threads)` : ""}, loaded in ${(data.loadMs / 1000).toFixed(1)} s.`;
      for (const v of data.voices) {
        const o = new Option(v.description ? `${v.name} (${v.description})` : v.name, v.name);
        $("voice").add(o);
      }
      $("voice").value = data.defaultVoice;
      for (const v of await listVoices().catch(() => [])) userVoices.set(v.id, v);
      renderUserVoices();
      $("tts").hidden = false;
      $("clone").hidden = false;
      // Everything is cached now: ask the browser not to evict it, then report.
      requestPersist().catch(() => false).then(showStorage);
      break;
    }
    case "chunk":
      $("status").textContent = `Chunk ${data.index + 1} of ${data.count}…`;
      $("phonemes").textContent += `${data.text}\n→ ${data.phonemes}\n\n`;
      break;
    case "step":
      $("status").textContent = `Chunk ${data.index + 1}, step ${data.step}/${data.steps}`;
      break;
    case "done": {
      const secs = data.wav.length / data.sampleRate;
      const gen = data.genMs / 1000;
      $("status").textContent = `${secs.toFixed(1)} s of audio in ${gen.toFixed(1)} s (${(gen / secs).toFixed(2)}× real time)`;
      if (lastUrl) URL.revokeObjectURL(lastUrl);
      lastUrl = URL.createObjectURL(new Blob([encodeWav(data.wav, data.sampleRate)], { type: "audio/wav" }));
      $("player").src = lastUrl;
      $("player").hidden = false;
      $("download").href = lastUrl;
      $("download").hidden = false;
      $("player").play().catch(() => {});
      $("speak").disabled = false;
      break;
    }
    case "cloned":
      onCloned(data);
      break;
    case "error":
      if (data.id !== undefined && data.id === cloneJob) {
        cloneJob = null;
        $("clone-status").textContent = `Couldn't create the voice: ${data.message}`;
        updateCreateButton();
        break;
      }
      $("status").textContent = `Error: ${data.message}`;
      $("progress-text").textContent = $("tts").hidden ? `Error: ${data.message}` : $("progress-text").textContent;
      $("speak").disabled = false;
      $("load").disabled = false;
      $("backend").disabled = false;
      break;
  }
};
