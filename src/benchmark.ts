/**
 * benchmark.ts — Real, reproducible compression benchmarks.
 *
 * Generates representative payloads (verbose logs, JSON, HTML, source code, a
 * RAG-style concatenation), then reports exact BPE tokens before/after, percent
 * saved, and wall-clock time. Also exercises budget mode: given a target, did
 * crushToBudget actually land under it, and how fast?
 *
 * Run: `npm run benchmark`. Output is deterministic (fixed fixtures) except for
 * timings. Uses a temp MESHMIND_HOME so it never touches the real store.
 */

import os from "node:os";
import path from "node:path";
import { rmSync } from "node:fs";

process.env.MESHMIND_HOME = path.join(os.tmpdir(), `mm-bench-home-${process.pid}`);

const { crush, crushToBudget, countTokens } = await import("./crusher.js");

/* ---- fixtures ----------------------------------------------------------- */
function verboseLog(n: number): string {
  const lines: string[] = [];
  for (let i = 0; i < n; i++) {
    if (i % 5 === 0) lines.push("ERROR  connection refused (ECONNREFUSED) — retrying in 200ms");
    else if (i % 5 === 1)
      lines.push("ERROR  connection refused (ECONNREFUSED) — retrying in 200ms");
    else
      lines.push(
        `INFO   ${new Date(1700000000000 + i * 1000).toISOString()} request ${i} handled in ${10 + (i % 40)}ms by worker-${i % 8}`,
      );
  }
  return lines.join("\n");
}

function bigJson(n: number): string {
  const arr = Array.from({ length: n }, (_, i) => ({
    id: i,
    name: `item-${i}`,
    active: i % 2 === 0,
    tags: ["alpha", "beta", "gamma"].slice(0, (i % 3) + 1),
    meta: { created: "2026-06-16T00:00:00Z", score: (i * 7) % 100 },
  }));
  return JSON.stringify(arr, null, 2);
}

function htmlPage(n: number): string {
  const items = Array.from(
    { length: n },
    (_, i) =>
      `<li class="row" data-id="${i}"><a href="/x/${i}">Item ${i}</a><span class="muted">detail ${i}</span></li>`,
  ).join("\n");
  return `<!doctype html><html><head><style>.row{display:flex}.muted{color:#999}</style>
<script>window.__DATA__=${JSON.stringify({ n })};track();</script></head>
<body><nav>Home · About · Contact</nav><main><h1>Listing</h1><ul>
${items}
</ul></main><footer>© 2026 Example Inc. All rights reserved.</footer></body></html>`;
}

function ragConcat(n: number): string {
  const para =
    "The Model Context Protocol is an open standard that lets AI agents connect to tools and data sources. " +
    "It is transport-agnostic and works over stdio or HTTP. Servers expose tools, resources, and prompts. ";
  // simulate retrieved chunks with heavy overlap (the realistic RAG case)
  return Array.from({ length: n }, (_, i) => `[chunk ${i}]\n${para}${para}`).join("\n\n");
}

/* ---- harness ------------------------------------------------------------ */
interface Row {
  name: string;
  origTok: number;
  crushedTok: number;
  pct: number;
  ms: number;
}

function bench(name: string, input: string): Row {
  const origTok = countTokens(input);
  const t0 = performance.now();
  const r = crush(input);
  const ms = performance.now() - t0;
  return { name, origTok, crushedTok: r.crushedTokens, pct: r.savedPercent, ms };
}

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function printTable(rows: Row[]): void {
  const head = ["fixture", "orig tok", "crushed", "saved", "ms"];
  const data = rows.map((r) => [
    r.name,
    fmt(r.origTok),
    fmt(r.crushedTok),
    `${r.pct}%`,
    r.ms.toFixed(1),
  ]);
  const widths = head.map((h, c) => Math.max(h.length, ...data.map((d) => d[c].length)));
  const line = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  console.log(line(head));
  console.log(widths.map((w) => "─".repeat(w)).join("  "));
  for (const d of data) console.log(line(d));
}

async function main() {
  console.log("\n=== MeshMind compression benchmark ===\n");
  console.log(`node ${process.version} · ${os.platform()}/${os.arch()}\n`);

  const rows: Row[] = [
    bench("verbose log (2k lines)", verboseLog(2000)),
    bench("JSON array (2k objects)", bigJson(2000)),
    bench("HTML listing (1k rows)", htmlPage(1000)),
    bench("RAG concat (200 chunks)", ragConcat(200)),
    bench("source code (this repo)", await readSelf()),
  ];
  printTable(rows);

  const totalOrig = rows.reduce((a, r) => a + r.origTok, 0);
  const totalCrush = rows.reduce((a, r) => a + r.crushedTok, 0);
  const totalPct = Math.round(((totalOrig - totalCrush) / totalOrig) * 1000) / 10;
  console.log(
    `\nTOTAL: ${fmt(totalOrig)} → ${fmt(totalCrush)} tokens  (-${totalPct}%, ${fmt(totalOrig - totalCrush)} saved)\n`,
  );

  // --- budget mode accuracy ---
  console.log("=== Budget mode (crushToBudget) ===\n");
  const log = verboseLog(2000);
  const budgets = [2000, 1000, 400, 150];
  console.log("input: verbose log (2k lines), orig", fmt(countTokens(log)), "tok\n");
  console.log("target   result   hit   ms    stages");
  console.log("──────   ──────   ───   ────  ──────");
  for (const target of budgets) {
    const t0 = performance.now();
    const b = crushToBudget(log, target);
    const ms = performance.now() - t0;
    console.log(
      `${String(target).padStart(6)}   ${String(b.crushedTokens).padStart(6)}   ` +
        `${b.hitBudget ? " ✓ " : " ✗ "}   ${ms.toFixed(0).padStart(4)}  ${b.escalation.length}`,
    );
  }
  console.log("");

  try {
    rmSync(process.env.MESHMIND_HOME!, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

async function readSelf(): Promise<string> {
  const { readFileSync, readdirSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const dir = path.dirname(fileURLToPath(import.meta.url));
  // concatenate the compiled JS of this build as a realistic code payload
  return readdirSync(dir)
    .filter((f) => f.endsWith(".js"))
    .map((f) => {
      try {
        return readFileSync(path.join(dir, f), "utf8");
      } catch {
        return "";
      }
    })
    .join("\n");
}

main().catch((e) => {
  console.error("benchmark fatal:", e);
  process.exit(1);
});
