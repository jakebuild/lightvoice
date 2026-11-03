// Text -> chunks of normalized text -> phonemes. A port of
// vieneu_utils.phonemize_text.normalize_to_chunks_v3_with_gaps and
// phonemize_text_with_emotions; normalization and G2P themselves come from
// sea-g2p compiled to WASM (`g2p` below is its SeaG2p object).
//
// Order matters, as in Python: split sentences on the RAW text, then
// normalize — the normalizer strips quotes and brackets, after which a "?"
// inside a quotation would look like a sentence end.

const SENT_END = new Set(".!?…");
const OPEN_TO_CLOSE = { "(": ")", "[": "]", "{": "}", "“": "”", "‘": "’", "«": "»", "‹": "›", "「": "」", "『": "』" };
const OPENERS = new Set(Object.keys(OPEN_TO_CLOSE));
const CLOSERS = new Set(Object.values(OPEN_TO_CLOSE));
const TRAILING_CLOSE = new Set([...CLOSERS, '"', "'", "’", "”"]);
const MINOR_PUNCT = /(?<=[,;:\-–—])\s+/;
const EMOTION_TOKEN = /<\|emotion_\d+\|>/g;
const EMOTION_SPLIT = /(\[[^\]]+\]|<\|emotion_\d+\|>)/;
const ATTACHING_PUNCT = new Set(".,!?;:…)]}\"'’”");
const EMOTION_TAG_TO_K = {
  chuckle: 1, "cười": 1, cuoi: 1,
  sigh: 2, "thở dài": 2, "tho dai": 2,
  "clear throat": 3, "hắng giọng": 3, "hang giong": 3,
};
const TAIL_SLACK = 15;
const MIN_CHUNK_CHARS = 20;

function scanSentences(text, quoteAware) {
  const out = [];
  let start = 0;
  let i = 0;
  let depth = 0;
  let inQuote = false;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (quoteAware && ch === '"') inQuote = !inQuote;
    else if (quoteAware && OPENERS.has(ch)) depth++;
    else if (quoteAware && CLOSERS.has(ch)) depth = Math.max(0, depth - 1);
    else if (SENT_END.has(ch) && depth === 0 && !inQuote) {
      let j = i + 1;
      while (j < n && SENT_END.has(text[j])) j++;
      while (j < n && TRAILING_CLOSE.has(text[j])) j++;
      // Only a boundary before whitespace or the end, so "3.5 triệu" stays whole.
      if (j >= n || /\s/.test(text[j])) {
        out.push(text.slice(start, j));
        start = i = j;
        continue;
      }
      i = j;
      continue;
    }
    i++;
  }
  if (start < n) out.push(text.slice(start));
  return [out.map((s) => s.trim()).filter(Boolean), depth === 0 && !inQuote];
}

export function splitIntoSentences(text) {
  if (!text) return [];
  const [s, balanced] = scanSentences(text, true);
  return balanced ? s : scanSentences(text, false)[0];
}

const tailSlack = (maxChars) => Math.min(TAIL_SLACK, Math.floor(maxChars / 8));

function fits(curLen, addLen, maxChars) {
  const total = curLen ? curLen + 1 + addLen : addLen;
  const slack = tailSlack(maxChars);
  return total <= maxChars || (addLen <= slack && total <= maxChars + slack);
}

// Python cuts an over-long, punctuation-free run at a balanced point and avoids
// splitting numbers and connectives; this simpler version cuts evenly by word.
function splitLongPart(part, maxChars) {
  const words = part.split(/\s+/).filter(Boolean);
  const total = part.length;
  const k = Math.ceil(total / maxChars);
  const target = total / k;
  const pieces = [];
  let cur = [];
  let len = 0;
  for (const w of words) {
    const add = len ? len + 1 + w.length : w.length;
    if (len && add > target && pieces.length < k - 1) {
      pieces.push(cur.join(" "));
      cur = [w];
      len = w.length;
    } else {
      cur.push(w);
      len = add;
    }
  }
  if (cur.length) pieces.push(cur.join(" "));
  return pieces;
}

export function packSentences(sentences, maxChars) {
  const chunks = [];
  let buf = "";
  for (let s of sentences) {
    s = s.trim();
    if (!s) continue;
    if (s.length > maxChars) {
      if (buf) {
        chunks.push(buf);
        buf = "";
      }
      for (let part of s.split(MINOR_PUNCT)) {
        part = part.trim();
        if (!part) continue;
        if (fits(buf.length, part.length, maxChars)) {
          buf = buf ? `${buf} ${part}` : part;
        } else {
          if (buf) chunks.push(buf);
          buf = part;
          if (buf.length > maxChars) {
            const pieces = splitLongPart(buf, maxChars);
            chunks.push(...pieces.slice(0, -1));
            buf = pieces.at(-1) ?? "";
          }
        }
      }
    } else if (buf && !fits(buf.length, s.length, maxChars)) {
      chunks.push(buf);
      buf = s;
    } else {
      buf = buf ? `${buf} ${s}` : s;
    }
  }
  if (buf) chunks.push(buf);
  return chunks.map((c) => c.trim()).filter(Boolean);
}

function emotionToken(tag) {
  const t = tag.trim();
  if (t.startsWith("<|")) return t;
  const k = EMOTION_TAG_TO_K[t.slice(1, -1).trim().toLowerCase()];
  return k === undefined ? null : `<|emotion_${k}|>`;
}

function normalizeKeepCues(g2p, sentence) {
  if (!sentence.includes("[") && !sentence.includes("<|emotion_")) return g2p.normalize(sentence, false);
  const parts = [];
  sentence.split(EMOTION_SPLIT).forEach((part, i) => {
    if (i % 2 === 1) parts.push(emotionToken(part) ?? part);
    else if (part.trim()) parts.push(g2p.normalize(part, false));
  });
  return parts.filter(Boolean).join(" ");
}

const effectiveLen = (c) => c.replace(EMOTION_TOKEN, "").trim().length;
const classifyGap = (c) => (/[.!?]$/.test(c.trimEnd()) ? "sentence" : "minor");

function mergeShort(chunks, gaps, minChars) {
  while (chunks.length > 1) {
    const short = chunks.map((c, i) => i).filter((i) => effectiveLen(chunks[i]) < minChars);
    if (!short.length) break;
    const i = short.reduce((a, b) => (effectiveLen(chunks[b]) < effectiveLen(chunks[a]) ? b : a));
    // Prefer a non-paragraph boundary, then the shorter neighbour, then the right side.
    const sides = [];
    if (i < chunks.length - 1) sides.push([gaps[i] !== "para", -chunks[i + 1].length, "R"]);
    if (i > 0) sides.push([gaps[i - 1] !== "para", -chunks[i - 1].length, "L"]);
    const side = sides.reduce((a, b) => (b[0] > a[0] || (b[0] === a[0] && b[1] > a[1]) ? b : a))[2];
    if (side === "R") {
      chunks[i] = `${chunks[i]} ${chunks.splice(i + 1, 1)[0]}`;
      gaps.splice(i, 1);
    } else {
      chunks[i - 1] = `${chunks[i - 1]} ${chunks.splice(i, 1)[0]}`;
      gaps.splice(i - 1, 1);
    }
  }
  return [chunks, gaps];
}

/** Raw text -> { chunks, gaps } of normalized text, gaps in {"para","sentence","minor"}. */
export function textToChunks(g2p, text, maxChars = 140) {
  if (!text) return { chunks: [], gaps: [] };
  const keepCues = text.includes("[") || text.includes("<|emotion_");
  let chunks = [];
  let gaps = [];
  for (const para of text.split(/[\r\n]+/).filter((p) => p.trim())) {
    const sentences = splitIntoSentences(para).map((s) => (keepCues ? normalizeKeepCues(g2p, s) : g2p.normalize(s, false)));
    const paraChunks = packSentences(sentences, maxChars);
    if (!paraChunks.length) continue;
    if (chunks.length) gaps.push("para");
    paraChunks.forEach((c, j) => {
      if (j > 0) gaps.push("sentence");
      chunks.push(c);
    });
  }
  chunks = chunks.map((c) => g2p.puncNorm(c));
  gaps = gaps.map((g, i) => (g === "para" ? g : classifyGap(chunks[i])));
  [chunks, gaps] = mergeShort(chunks, gaps, MIN_CHUNK_CHARS);
  return { chunks, gaps };
}

/** One chunk -> phonemes, keeping inline cues ([cười], [thở dài], ...) as emotion tokens. */
export function phonemizeChunk(g2p, text) {
  if (!text.includes("[") && !text.includes("<|emotion_")) return g2p.phonemize(text, true);
  let out = "";
  text.split(EMOTION_SPLIT).forEach((part, i) => {
    const token = i % 2 === 1 ? emotionToken(part) : null;
    if (token) {
      out = out ? `${out} ${token}` : token;
      return;
    }
    const ph = part && part.trim() ? g2p.phonemize(part, false) : "";
    if (!ph) return;
    if (!out) out = ph;
    else if (ATTACHING_PUNCT.has(ph[0])) out += ph;
    else out += ` ${ph}`;
  });
  return g2p.puncNorm(out);
}
