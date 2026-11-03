// Voices the user cloned, kept in this browser only (Cache Storage, same
// persistence as the model). A voice is { id, name, created, spk: number[192],
// style: number[50*256] } — about 70 KB as JSON.

const STORE = "lightvoice-user-voices-v1";
const url = (id) => new URL(`user-voices/${id}.json`, location.href).href;

export async function listVoices() {
  const cache = await caches.open(STORE);
  const voices = [];
  for (const req of await cache.keys()) voices.push(await (await cache.match(req)).json());
  return voices.sort((a, b) => a.created - b.created);
}

export async function saveVoice({ name, spk, style }) {
  const voice = { id: crypto.randomUUID(), name, created: Date.now(), spk: Array.from(spk), style: Array.from(style) };
  const cache = await caches.open(STORE);
  await cache.put(url(voice.id), new Response(JSON.stringify(voice), { headers: { "content-type": "application/json" } }));
  return voice;
}

export async function deleteVoice(id) {
  await (await caches.open(STORE)).delete(url(id));
}

/** Decode any audio file/blob the browser understands into trimmed 24 kHz + 16 kHz mono. */
export async function decodeClip(blob, trimSilence) {
  const bytes = await blob.arrayBuffer();
  // decodeAudioData resamples to the context's rate: 24 kHz is what the codec encoder takes.
  const decoded = await new OfflineAudioContext(1, 1, 24000).decodeAudioData(bytes);
  const mono = new Float32Array(decoded.length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const ch = decoded.getChannelData(c);
    for (let i = 0; i < mono.length; i++) mono[i] += ch[i] / decoded.numberOfChannels;
  }
  const wav24 = trimSilence(mono).slice();
  // The speaker encoder wants 16 kHz: let the browser's resampler render a copy.
  const ctx16 = new OfflineAudioContext(1, Math.max(1, Math.ceil((wav24.length * 16000) / 24000)), 16000);
  const buf = ctx16.createBuffer(1, Math.max(1, wav24.length), 24000);
  buf.copyToChannel(wav24, 0);
  const src = ctx16.createBufferSource();
  src.buffer = buf;
  src.connect(ctx16.destination);
  src.start();
  const wav16 = (await ctx16.startRendering()).getChannelData(0).slice();
  return { wav24, wav16, seconds: wav24.length / 24000, peak: wav24.reduce((m, x) => Math.max(m, Math.abs(x)), 0) };
}
