/**
 * test-unit.ts — Deterministic, offline unit tests. No network, no MCP
 * transport — pure module behavior so CI is fast and reliable. The live
 * network paths are covered separately by `npm run test:network`.
 */

import os from "node:os";
import path from "node:path";
import { promises as fs, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Isolate the persistent store in a temp dir so tests never touch the real
// ~/.meshmind and stay deterministic. Must be set before crusher/store run.
const TEST_HOME = path.join(os.tmpdir(), `mm-test-home-${process.pid}`);
process.env.MESHMIND_HOME = TEST_HOME;

const { crush, crushToBudget, preview, retrieve, stats, countTokens, crushCode, crushWeb } =
  await import("./crusher.js");
const { scanCodebase, exportMermaid } = await import("./mapper.js");

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function pass(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✅" : "❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  // --- tokenizer ---
  pass(
    "countTokens uses real BPE",
    countTokens("hello world") === 2,
    `got ${countTokens("hello world")}`,
  );
  pass("countTokens empty = 0", countTokens("") === 0);

  // --- crushCode ---
  const code = "// gone\n/* gone */\nfunction f(){ return 1; }\n";
  const cc = crushCode(code);
  pass("crushCode strips comments", !cc.includes("gone") && cc.includes("function f"));

  // --- crushWeb ---
  const web = "<style>.x{}</style><nav>n</nav><p>Keep &amp; this</p><script>x()</script>";
  const cw = crushWeb(web);
  pass(
    "crushWeb strips boilerplate",
    cw.includes("Keep & this") && !cw.includes("x()") && !cw.includes(".x{"),
  );

  // --- reversibility + ref stability ---
  const r1 = crush("// c\nconst a = 1;\n", { mode: "code" });
  pass("crush returns cf_ ref", r1.ref.startsWith("cf_"));
  pass("retrieve recovers original", retrieve(r1.ref) === "// c\nconst a = 1;\n");
  pass("retrieve unknown ref = null", retrieve("cf_doesnotexist") === null);
  const r2 = crush("// c\nconst a = 1;\n", { mode: "code" });
  pass("ref is content-addressed (stable)", r1.ref === r2.ref);

  // --- algorithms ---
  const dd = crush("a\na\na\nb\n", { algorithms: ["line-dedup"] });
  pass("line-dedup collapses", dd.text.includes("(x3)"));
  const jm = crush('{"a":  1,  "b": 2}', { algorithms: ["json-min"] });
  pass("json-min minifies", jm.text === '{"a":1,"b":2}');
  const tr = crush(Array.from({ length: 50 }, (_, i) => `line${i}`).join("\n"), {
    algorithms: ["truncate"],
    maxLines: 10,
    keepFirst: 2,
    keepLast: 2,
  });
  pass(
    "truncate elides middle",
    tr.text.includes("elided") && tr.text.includes("line0") && tr.text.includes("line49"),
  );
  const sw = crush("the cat sat on the mat", { mode: "web", algorithms: ["stopwords"] });
  pass("stopwords removes filler", !/\bthe\b/.test(sw.text) && sw.text.includes("cat"));
  const sm = crush(
    "Cats are great. Cats purr loudly. The weather is nice today. Cats sleep a lot. Cats are independent animals.",
    { algorithms: ["summarize"], summaryRatio: 0.4 },
  );
  pass("summarize keeps salient sentences", sm.text.length < 110 && /Cats/.test(sm.text));

  // --- savings metrics sane ---
  const big = crush("<div>" + "x ".repeat(200) + "</div>", { mode: "web" });
  pass(
    "savings metrics computed",
    big.savedPercent >= 0 && big.crushedTokens <= big.originalTokens,
  );

  // --- persistent store: ref grows + session stats track ---
  const before = stats().session.cachedRefs;
  const persistRes = crush("unique-persist-" + Date.now(), { mode: "web" });
  pass(
    "cache grows + session stats track",
    stats().session.cachedRefs >= before && stats().session.calls > 0,
  );

  // --- persistence: original lives on disk + survives a fresh module read ---
  pass(
    "original persisted to disk under MESHMIND_HOME",
    existsSync(path.join(TEST_HOME, "originals", `${persistRes.ref}.json`)),
  );
  // re-import the store module fresh (simulates a new process) and retrieve
  const freshStore = await import(`./store.js?fresh=${Date.now()}`);
  pass(
    "ref retrievable after simulated restart",
    freshStore.getOriginal(persistRes.ref)?.startsWith("unique-persist-") === true,
  );

  // --- lifetime stats accumulate + carry timestamps ---
  const life = stats().lifetime;
  pass(
    "lifetime stats accumulate",
    life.calls >= stats().session.calls && typeof life.firstSeen === "string",
    `lifetime.calls=${life.calls}`,
  );

  // --- budget mode: escalates to fit a token budget ---
  const bigLog = Array.from({ length: 400 }, (_, i) =>
    i % 3 === 0 ? "ERROR connection refused" : `event ${i} processed ok at node-${i % 7}`,
  ).join("\n");
  const budget = crushToBudget(bigLog, 80, { mode: "code" });
  pass(
    "crushToBudget fits the token budget",
    budget.hitBudget && budget.crushedTokens <= 80,
    `${budget.originalTokens}→${budget.crushedTokens} tok, stages=${budget.escalation.length}`,
  );
  pass("crushToBudget returns a real ref", retrieve(budget.ref) === bigLog);

  // --- preview: per-step breakdown, no ref stored, no stats change ---
  const refsBefore = stats().session.cachedRefs;
  const callsBefore = stats().session.calls;
  const prev = preview("// c\n\n\nconst a=1;\n\n\nconst b=2;\n", { mode: "code" });
  pass(
    "preview returns per-step breakdown",
    Array.isArray(prev.steps) && prev.steps.length > 0 && prev.steps[0].algo === "strip",
  );
  pass(
    "preview does not store a ref or touch stats",
    stats().session.cachedRefs === refsBefore && stats().session.calls === callsBefore,
  );

  // --- mapper: scan this project's src (offline) ---
  const map = await scanCodebase(__dirname.replace(/build$/, "src"));
  pass("scanCodebase finds files", map.fileCount > 0 && map.astFiles > 0);
  pass("scanCodebase builds edges", map.edges.length > 0);
  pass("scanCodebase clusters", map.analysis.communityCount >= 1);
  pass(
    "scanCodebase confidence labels",
    map.edges.some((e) => e.confidence === "EXTRACTED"),
  );

  // --- mapper: ast-grep multi-language (offline, temp fixtures) ---
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mm-unit-"));
  await fs.writeFile(path.join(dir, "a.py"), "def foo():\n    return 1\nclass Bar:\n    pass\n");
  await fs.writeFile(path.join(dir, "b.rs"), "fn main() { foo(); }\nstruct Cfg { n: i32 }\n");
  const m2 = await scanCodebase(dir);
  const syms = m2.nodes.filter((n) => n.kind === "symbol").map((n) => n.label);
  pass(
    "ast-grep python+rust symbols",
    syms.includes("foo") && syms.includes("Bar") && syms.includes("Cfg"),
    `[${syms.join(",")}]`,
  );
  await fs.rm(dir, { recursive: true, force: true });

  // --- mermaid export ---
  pass("exportMermaid produces graph", exportMermaid(map).startsWith("graph LR"));

  try {
    rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }

  console.log(failures ? `\n${failures} unit test(s) failed.\n` : "\nAll unit tests passed.\n");
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error("test-unit fatal:", e);
  process.exit(1);
});
