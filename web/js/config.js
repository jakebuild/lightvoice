// Cache Storage bucket for the model, voices and dictionary. Each file is
// cached under `path?v=<content hash>` from assets.json, so a changed file is
// re-downloaded on its own and the worker drops the stale copy; this bucket
// name only needs a bump if the caching scheme itself changes. The worker
// deletes every other bucket with this prefix once the current one is loaded.
export const MODEL_CACHE_PREFIX = "lightvoice-models-";
export const MODEL_CACHE = `${MODEL_CACHE_PREFIX}v4`; // v4: per-file content hashes

/** Model-bucket file URL, versioned by content hash. */
export const versionedUrl = (file, base) => `${new URL(file.path, base).href}?v=${file.hash}`;
