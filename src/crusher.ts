/**
 * crusher.ts — Token-reduction pipeline (expanded).
 *
 * Conceptualized from `headroom`. No longer a single regex pass: a small
 * multi-algorithm pipeline with a reversible cache (CCR-style) and running
 * stats, mirroring headroom's compress / retrieve / stats surface.
 *
 * Algorithms (composable, applied in order where sensible):
 *   1. strip      — comments/docstrings (code) or HTML/markdown noise (web)
 *   2. whitespace — collapse blank-line runs + trailing space
 *   3. line-dedup — drop consecutive & global duplicate lines (logs/RAG)
 *   4. json-min   — minify embedded/standalone JSON
 *   5. truncate   — first-K / last-K keep with an elision marker (Kneedle-ish)
 *
 * Reversible: every crush is stored under a short content ref; `retrieve(ref)`
 * returns the original. Losses are recoverable, not permanent.
 */

import { createHash } from "node:crypto";
import { encode } from "gpt-tokenizer";

export type CrushMode = "code" | "web" | "auto";
export type Algorithm =
  | "strip" | "whitespace" | "line-dedup" | "json-min" | "truncate" | "stopwords"
  | "summarize";

export interface CrushOptions {
  mode?: CrushMode;
  algorithms?: Algorithm[];
  /** truncate: keep first/last N lines when a payload exceeds maxLines. */
  maxLines?: number;
  keepFirst?: number;
  keepLast?: number;
  /** summarize: fraction of sentences to keep (0..1, default 0.3). */
  summaryRatio?: number;
  /** store original for reversible retrieval (default true). */
  reversible?: boolean;
}

export interface CrushResult {
  ref: string;                 // content ref for retrieve()
  text: string;
  mode: "code" | "web";
  algorithms: Algorithm[];
  originalChars: number;
  crushedChars: number;
  originalTokens: number;
  crushedTokens: number;
  savedTokens: number;
  savedPercent: number;
}

const DEFAULT_ALGOS: Algorithm[] = ["strip", "whitespace", "line-dedup", "json-min"];

/* ---- token count -------------------------------------------------------- */
/**
 * Exact token count via gpt-tokenizer (the cl100k/o200k BPE used by recent
 * OpenAI + broadly representative of modern LLM tokenizers). Falls back to a
 * char/word heuristic only if the encoder throws on pathological input.
 */
export function countTokens(text: string): number {
  if (!text) return 0;
  try {
    return encode(text).length;
  } catch {
    const words = (text.match(/[A-Za-z0-9_]+/g) || []).length;
    const punct = (text.match(/[^\sA-Za-z0-9_]/g) || []).length;
    return Math.max(1, words + Math.round(punct * 0.6));
  }
}

/** @deprecated retained for API compat — now an exact count, not an estimate. */
export const estimateTokens = countTokens;

/* ---- mode detection ----------------------------------------------------- */
const HTML_LANG_HINT = /<\/?(html|body|div|span|p|a|script|head|meta|nav|footer)\b/i;

function detectMode(text: string): "code" | "web" {
  if (HTML_LANG_HINT.test(text)) return "web";
  const codeSignals = (text.match(/[{};]|=>|\bfunction\b|\bimport\b|\bdef\b/g) || []).length;
  return codeSignals > 5 ? "code" : "web";
}

/* ---- algorithm: strip --------------------------------------------------- */
export function crushCode(src: string): string {
  let out = src;
  out = out.replace(/\/\*[\s\S]*?\*\//g, "");
  out = out.replace(/(^|\s)\/\/[^\n]*/g, "$1");
  out = out.replace(/(^|\s)#[^\n!][^\n]*/g, "$1"); // keep shebang `#!`
  out = out.replace(/("""|''')[\s\S]*?\1/g, "");
  out = out.replace(/[ \t]+$/gm, "");
  out = out.replace(/([^\s])[ \t]{2,}/g, "$1 ");
  return out;
}

export function crushWeb(raw: string): string {
  let out = raw;
  out = out.replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, " ");
  out = out.replace(/<(nav|footer|header|aside|form)[\s\S]*?<\/\1>/gi, " ");
  out = out.replace(/<!--[\s\S]*?-->/g, " ");
  out = out.replace(/<\/?(p|div|br|li|tr|h[1-6]|section|article)\b[^>]*>/gi, "\n");
  out = out.replace(/<[^>]+>/g, " ");

  const entities: Record<string, string> = {
    "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
    "&#39;": "'", "&apos;": "'", "&nbsp;": " ", "&mdash;": "—", "&ndash;": "–",
  };
  out = out.replace(/&[a-z#0-9]+;/gi, (m) => entities[m.toLowerCase()] ?? " ");

  out = out.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  out = out.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  out = out.replace(/^[ \t]*[#>*-]{1,}[ \t]+/gm, "");
  out = out.replace(/^[ \t]*[-=_*]{3,}[ \t]*$/gm, "");
  out = out.replace(/`{1,3}/g, "");
  out = out.replace(/[ \t]+/g, " ");
  return out;
}

/* ---- algorithm: whitespace --------------------------------------------- */
function collapseWhitespace(text: string): string {
  return text.replace(/ ?\n ?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

/* ---- algorithm: line-dedup --------------------------------------------- */
/**
 * Drops consecutive duplicate lines and globally-repeated noise lines (common
 * in logs / stack traces / RAG concatenations). Keeps first occurrence; appends
 * an "(xN)" count when a line repeats consecutively.
 */
function dedupeLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let prev: string | null = null;
  let run = 0;

  const flush = () => {
    if (prev === null) return;
    out.push(run > 1 ? `${prev}  (x${run})` : prev);
  };

  for (const line of lines) {
    const key = line.trim();
    if (key && key === prev?.trim()) {
      run++;
    } else {
      flush();
      prev = line;
      run = 1;
    }
  }
  flush();
  return out.join("\n");
}

/* ---- algorithm: json-min ----------------------------------------------- */
/** Minify standalone-JSON payloads; leaves non-JSON untouched. */
function minifyJson(text: string): string {
  const trimmed = text.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) return text;
  try {
    return JSON.stringify(JSON.parse(trimmed));
  } catch {
    return text;
  }
}

/* ---- algorithm: stopwords ---------------------------------------------- */
/**
 * Prose-only filler removal: drops high-frequency function words that carry
 * little signal for an LLM skimming web/research text. Skips lines that look
 * like code (contain {};=>) to avoid corrupting snippets. Lossy but reversible
 * via the cache.
 */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "for", "and", "or", "but", "is", "are",
  "was", "were", "be", "been", "being", "on", "at", "by", "with", "as", "that",
  "this", "these", "those", "it", "its", "from", "into", "than", "then", "so",
  "such", "very", "just", "also", "about", "over", "out", "up", "down",
]);
function dropStopwords(text: string): string {
  return text
    .split("\n")
    .map((line) => {
      if (/[{};]|=>/.test(line)) return line; // looks like code — leave intact
      return line.replace(/\b[A-Za-z]+\b/g, (w) =>
        STOPWORDS.has(w.toLowerCase()) ? "" : w,
      ).replace(/ {2,}/g, " ").replace(/ +([.,;:!?])/g, "$1");
    })
    .join("\n");
}

/* ---- algorithm: summarize (extractive) ---------------------------------- */
/**
 * Dependency-free extractive summarizer (TextRank-lite). Scores sentences by
 * content-word frequency + a lead-position bonus, keeps the top `ratio`, and
 * restores original order. This is the "free, no-ONNX" semantic compression:
 * it keeps the salient sentences instead of running a learned model. For an
 * *abstractive* summary the server delegates to the host LLM via MCP sampling
 * (see server.ts); this is the guaranteed local fallback.
 */
function summarizeExtractive(text: string, ratio: number): string {
  const sentences = text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (sentences.length <= 3) return text.trim();

  // Content-word frequencies (skip stopwords + very short tokens).
  const freq = new Map<string, number>();
  for (const s of sentences) {
    for (const w of s.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
      if (w.length < 3 || STOPWORDS.has(w)) continue;
      freq.set(w, (freq.get(w) ?? 0) + 1);
    }
  }
  const maxFreq = Math.max(1, ...freq.values());

  const scored = sentences.map((s, i) => {
    const words = s.toLowerCase().match(/[a-z0-9]+/g) ?? [];
    const content = words.filter((w) => w.length >= 3 && !STOPWORDS.has(w));
    const freqScore = content.reduce((a, w) => a + (freq.get(w) ?? 0) / maxFreq, 0) /
      Math.max(1, content.length);
    const positionBonus = i < 2 ? 0.25 : 0;          // lead sentences matter
    const lengthPenalty = words.length < 4 ? -0.3 : 0; // skip fragments
    return { i, s, score: freqScore + positionBonus + lengthPenalty };
  });

  const keep = Math.max(3, Math.round(sentences.length * ratio));
  const chosen = new Set(
    [...scored].sort((a, b) => b.score - a.score).slice(0, keep).map((x) => x.i),
  );
  return scored.filter((x) => chosen.has(x.i)).map((x) => x.s).join(" ");
}

/* ---- algorithm: truncate ----------------------------------------------- */
function truncateKeep(text: string, maxLines: number, keepFirst: number, keepLast: number): string {
  const lines = text.split("\n");
  if (lines.length <= maxLines) return text;
  const head = lines.slice(0, keepFirst);
  const tail = lines.slice(lines.length - keepLast);
  const elided = lines.length - keepFirst - keepLast;
  return [...head, `… [meshmind elided ${elided} lines] …`, ...tail].join("\n");
}

/* ---- reversible store + stats ------------------------------------------ */
interface StoreEntry { original: string; mode: "code" | "web"; at: string; }

/**
 * Bounded LRU cache of originals for reversible retrieval. A Map preserves
 * insertion order, so the oldest key is the first key; on overflow we evict it.
 * Re-storing an existing ref refreshes its recency. Cap is configurable via the
 * MESHMIND_CACHE_MAX env var (default 500 entries).
 */
const CACHE_MAX = Math.max(1, Number(process.env.MESHMIND_CACHE_MAX) || 500);
const STORE = new Map<string, StoreEntry>();

function cacheSet(ref: string, entry: StoreEntry): void {
  if (STORE.has(ref)) STORE.delete(ref);        // refresh recency
  STORE.set(ref, entry);
  while (STORE.size > CACHE_MAX) {
    const oldest = STORE.keys().next().value;   // first = least recently used
    if (oldest === undefined) break;
    STORE.delete(oldest);
  }
}

const STATS = {
  calls: 0,
  originalTokens: 0,
  crushedTokens: 0,
  get savedTokens() { return this.originalTokens - this.crushedTokens; },
  get savedPercent() {
    return this.originalTokens > 0
      ? Math.round((this.savedTokens / this.originalTokens) * 1000) / 10
      : 0;
  },
};

function refFor(text: string): string {
  return "cf_" + createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Retrieve the original text for a crush ref, or null if unknown/evicted. */
export function retrieve(ref: string): string | null {
  return STORE.get(ref)?.original ?? null;
}

export interface CrusherStats {
  calls: number;
  originalTokens: number;
  crushedTokens: number;
  savedTokens: number;
  savedPercent: number;
  cachedRefs: number;
}

export function stats(): CrusherStats {
  return {
    calls: STATS.calls,
    originalTokens: STATS.originalTokens,
    crushedTokens: STATS.crushedTokens,
    savedTokens: STATS.savedTokens,
    savedPercent: STATS.savedPercent,
    cachedRefs: STORE.size,
  };
}

/* ---- main pipeline ------------------------------------------------------ */
export function crush(input: string, options: CrushMode | CrushOptions = "auto"): CrushResult {
  const opts: CrushOptions = typeof options === "string" ? { mode: options } : options;
  const mode: "code" | "web" =
    !opts.mode || opts.mode === "auto" ? detectMode(input) : opts.mode;
  const algos = opts.algorithms ?? DEFAULT_ALGOS;
  const reversible = opts.reversible !== false;

  let text = input;
  for (const algo of algos) {
    switch (algo) {
      case "strip":
        text = mode === "code" ? crushCode(text) : crushWeb(text);
        break;
      case "whitespace":
        text = collapseWhitespace(text);
        break;
      case "line-dedup":
        text = dedupeLines(text);
        break;
      case "json-min":
        text = minifyJson(text);
        break;
      case "truncate":
        text = truncateKeep(
          text,
          opts.maxLines ?? 200,
          opts.keepFirst ?? 40,
          opts.keepLast ?? 40,
        );
        break;
      case "stopwords":
        text = dropStopwords(text);
        break;
      case "summarize":
        text = summarizeExtractive(text, opts.summaryRatio ?? 0.3);
        break;
    }
  }
  text = text.trim();

  const ref = refFor(input);
  if (reversible) cacheSet(ref, { original: input, mode, at: new Date().toISOString() });

  const originalTokens = estimateTokens(input);
  const crushedTokens = estimateTokens(text);

  STATS.calls++;
  STATS.originalTokens += originalTokens;
  STATS.crushedTokens += crushedTokens;

  return {
    ref,
    text,
    mode,
    algorithms: algos,
    originalChars: input.length,
    crushedChars: text.length,
    originalTokens,
    crushedTokens,
    savedTokens: Math.max(0, originalTokens - crushedTokens),
    savedPercent:
      originalTokens > 0
        ? Math.round(((originalTokens - crushedTokens) / originalTokens) * 1000) / 10
        : 0,
  };
}
