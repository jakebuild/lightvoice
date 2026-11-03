// What is already on this device, and whether the browser will keep it.
//
// Cache Storage is "best effort" by default: the browser may clear it when the
// disk runs low (and Safari clears script-written storage after 7 days without
// a visit unless the app is installed to the home screen). persist() asks the
// browser to exempt this site; Chrome decides silently from engagement,
// Firefox asks the user.

import { MODEL_CACHE, versionedUrl } from "./config.js";

/**
 * { files, totalBytes, savedBytes, modelBytesSaved, clone: { bytes, saved }, persisted, quota, usage }
 * Totals cover the core download; optional files (voice cloning) are reported under `clone`.
 */
export async function storageStatus() {
  const { files } = await (await fetch("assets.json")).json();
  const models = await caches.open(MODEL_CACHE);
  let savedBytes = 0;
  let totalBytes = 0;
  // The service worker precaches the runtime with the page itself, so only the
  // model bucket tells "never loaded" apart from "partly downloaded".
  let modelBytesSaved = 0;
  const clone = { bytes: 0, saved: true };
  for (const f of files) {
    const hit = f.cache === "models"
      ? await models.match(versionedUrl(f, location.href))
      : await caches.match(new URL(f.path, location.href).href, { ignoreSearch: true });
    if (f.optional) {
      clone.bytes += f.bytes;
      clone.saved &&= !!hit;
      continue;
    }
    totalBytes += f.bytes;
    if (!hit) continue;
    savedBytes += f.bytes;
    if (f.cache === "models") modelBytesSaved += f.bytes;
  }
  const persisted = (await navigator.storage?.persisted?.()) ?? false;
  const { quota = 0, usage = 0 } = (await navigator.storage?.estimate?.()) ?? {};
  return { files, totalBytes, savedBytes, modelBytesSaved, clone, persisted, quota, usage };
}

/** Ask to keep our storage. Returns whether it is (now) persistent. */
export async function requestPersist() {
  if (!navigator.storage?.persist) return false;
  if (await navigator.storage.persisted()) return true;
  return navigator.storage.persist();
}

export const mb = (bytes) => (bytes < 1e6 ? `${Math.max(1, Math.round(bytes / 1e3))} KB` : `${Math.round(bytes / 1e6)} MB`);
const SMALL_UPDATE = 5e6;

/** One line for the page. */
export function describe(s) {
  if (s.savedBytes >= s.totalBytes) {
    return s.persisted
      ? `Saved on this device (${mb(s.totalBytes)}). Protected from automatic cleanup, works offline.`
      : `Saved on this device (${mb(s.totalBytes)}), works offline. The browser may clear it if storage runs low.`;
  }
  const need = s.totalBytes - s.savedBytes;
  const free = s.quota ? s.quota - s.usage : Infinity;
  const space = free < need * 1.1 ? ` Only ${mb(free)} of browser storage is free, so the download may fail.` : "";
  if (s.modelBytesSaved > 0 && need < SMALL_UPDATE) {
    return `Saved on this device. An update (${mb(need)}) downloads when you load the model.${space}`;
  }
  return s.modelBytesSaved > 0
    ? `Partly downloaded (${mb(s.savedBytes)} of ${mb(s.totalBytes)}). Loading fetches the remaining ${mb(need)}.${space}`
    : `Not downloaded yet. The first load downloads ${mb(need)}, then works offline.${space}`;
}
