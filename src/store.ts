/**
 * store.ts — Persistent, disk-backed reversible store + lifetime stats.
 *
 * The headroom-style reversible cache used to live only in memory, so a `ref`
 * died when the process exited — you could not retrieve yesterday's compressed
 * blob. This store persists originals to disk under MESHMIND_HOME (default
 * ~/.meshmind), so refs survive restarts and savings accumulate over weeks.
 *
 * Design goals:
 *   - Dependency-free: plain JSON files, no native sqlite, works on Node 18+.
 *   - Fail-soft: if the disk is unavailable (read-only FS, sandbox), every
 *     operation silently falls back to an in-memory Map for the session.
 *   - Bounded: LRU eviction by file mtime, capped at MESHMIND_CACHE_MAX.
 *   - Synchronous: keeps crush() synchronous; sizes are tiny (a few hundred
 *     small files), so sync fs is simpler and fast enough.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface StoreEntry {
  original: string;
  mode: "code" | "web";
  at: string;
}

export interface LifetimeStats {
  calls: number;
  originalTokens: number;
  crushedTokens: number;
  firstSeen: string;
  lastSeen: string;
}

const CACHE_MAX = Math.max(1, Number(process.env.MESHMIND_CACHE_MAX) || 500);

/* ---- lazy paths (resolved on first use so tests can set MESHMIND_HOME) ---- */
let HOME: string | null = null;
let ORIGINALS: string | null = null;
let STATS_FILE: string | null = null;
let diskOk = true;

/** In-memory fallback used when the disk is unavailable. */
const memStore = new Map<string, StoreEntry>();
const memStats: LifetimeStats = {
  calls: 0,
  originalTokens: 0,
  crushedTokens: 0,
  firstSeen: new Date().toISOString(),
  lastSeen: new Date().toISOString(),
};

function paths(): { originals: string; statsFile: string } | null {
  if (!diskOk) return null;
  if (HOME && ORIGINALS && STATS_FILE) return { originals: ORIGINALS, statsFile: STATS_FILE };
  try {
    HOME = process.env.MESHMIND_HOME || path.join(os.homedir(), ".meshmind");
    ORIGINALS = path.join(HOME, "originals");
    STATS_FILE = path.join(HOME, "stats.json");
    fs.mkdirSync(ORIGINALS, { recursive: true });
    return { originals: ORIGINALS, statsFile: STATS_FILE };
  } catch {
    diskOk = false;
    return null;
  }
}

/** Atomic write: temp file + rename, so a crash never leaves a half file. */
function atomicWrite(file: string, data: string): boolean {
  try {
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, data, "utf8");
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

/* ---- originals ---------------------------------------------------------- */
export function putOriginal(ref: string, entry: StoreEntry): void {
  const p = paths();
  if (!p) {
    memStore.set(ref, entry);
    return;
  }
  const ok = atomicWrite(path.join(p.originals, `${ref}.json`), JSON.stringify(entry));
  if (!ok) {
    memStore.set(ref, entry);
    return;
  }
  // refresh recency so LRU keeps freshly-touched refs
  try {
    const now = new Date();
    fs.utimesSync(path.join(p.originals, `${ref}.json`), now, now);
  } catch {
    /* mtime refresh is best-effort */
  }
  pruneToCap();
}

export function getOriginal(ref: string): string | null {
  const p = paths();
  if (!p) return memStore.get(ref)?.original ?? null;
  try {
    const raw = fs.readFileSync(path.join(p.originals, `${ref}.json`), "utf8");
    const entry = JSON.parse(raw) as StoreEntry;
    // touch for LRU recency on read
    try {
      const now = new Date();
      fs.utimesSync(path.join(p.originals, `${ref}.json`), now, now);
    } catch {
      /* best-effort */
    }
    return entry.original;
  } catch {
    return memStore.get(ref)?.original ?? null;
  }
}

export function cachedRefCount(): number {
  const p = paths();
  if (!p) return memStore.size;
  try {
    return fs.readdirSync(p.originals).filter((f) => f.endsWith(".json")).length;
  } catch {
    return memStore.size;
  }
}

/** Evict least-recently-used (oldest mtime) refs beyond the cap. */
export function pruneToCap(): void {
  const p = paths();
  if (!p) {
    while (memStore.size > CACHE_MAX) {
      const oldest = memStore.keys().next().value;
      if (oldest === undefined) break;
      memStore.delete(oldest);
    }
    return;
  }
  try {
    const files = fs
      .readdirSync(p.originals)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const full = path.join(p.originals!, f);
        return { full, mtime: fs.statSync(full).mtimeMs };
      });
    if (files.length <= CACHE_MAX) return;
    files.sort((a, b) => a.mtime - b.mtime); // oldest first
    for (const { full } of files.slice(0, files.length - CACHE_MAX)) {
      try {
        fs.unlinkSync(full);
      } catch {
        /* best-effort */
      }
    }
  } catch {
    /* best-effort */
  }
}

/* ---- lifetime stats ----------------------------------------------------- */
export function recordCrush(originalTokens: number, crushedTokens: number): void {
  const p = paths();
  if (!p) {
    memStats.calls++;
    memStats.originalTokens += originalTokens;
    memStats.crushedTokens += crushedTokens;
    memStats.lastSeen = new Date().toISOString();
    return;
  }
  const cur = readLifetime();
  const next: LifetimeStats = {
    calls: cur.calls + 1,
    originalTokens: cur.originalTokens + originalTokens,
    crushedTokens: cur.crushedTokens + crushedTokens,
    firstSeen: cur.firstSeen,
    lastSeen: new Date().toISOString(),
  };
  atomicWrite(p.statsFile, JSON.stringify(next, null, 2));
}

export function readLifetime(): LifetimeStats {
  const p = paths();
  if (!p) return { ...memStats };
  try {
    const raw = fs.readFileSync(p.statsFile, "utf8");
    const parsed = JSON.parse(raw) as Partial<LifetimeStats>;
    return {
      calls: parsed.calls ?? 0,
      originalTokens: parsed.originalTokens ?? 0,
      crushedTokens: parsed.crushedTokens ?? 0,
      firstSeen: parsed.firstSeen ?? new Date().toISOString(),
      lastSeen: parsed.lastSeen ?? new Date().toISOString(),
    };
  } catch {
    return {
      calls: 0,
      originalTokens: 0,
      crushedTokens: 0,
      firstSeen: new Date().toISOString(),
      lastSeen: new Date().toISOString(),
    };
  }
}

/** Where originals live (for diagnostics / docs). null if disk unavailable. */
export function storeLocation(): string | null {
  const p = paths();
  return p ? p.originals : null;
}
