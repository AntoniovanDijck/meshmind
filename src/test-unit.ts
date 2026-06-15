/**
 * test-unit.ts — Deterministic, offline unit tests. No network, no MCP
 * transport — pure module behavior so CI is fast and reliable. The live
 * network paths are covered separately by `npm run test:network`.
 */

import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  crush, retrieve, stats, countTokens, crushCode, crushWeb,
} from "./crusher.js";
import { scanCodebase, exportMermaid } from "./mapper.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let failures = 0;
function pass(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✅" : "❌"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main() {
  // --- tokenizer ---
  pass("countTokens uses real BPE", countTokens("hello world") === 2, `got ${countTokens("hello world")}`);
  pass("countTokens empty = 0", countTokens("") === 0);

  // --- crushCode ---
  const code = "// gone\n/* gone */\nfunction f(){ return 1; }\n";
  const cc = crushCode(code);
  pass("crushCode strips comments", !cc.includes("gone") && cc.includes("function f"));

  // --- crushWeb ---
  const web = "<style>.x{}</style><nav>n</nav><p>Keep &amp; this</p><script>x()</script>";
  const cw = crushWeb(web);
  pass("crushWeb strips boilerplate", cw.includes("Keep & this") && !cw.includes("x()") && !cw.includes(".x{"));

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
    algorithms: ["truncate"], maxLines: 10, keepFirst: 2, keepLast: 2,
  });
  pass("truncate elides middle", tr.text.includes("elided") && tr.text.includes("line0") && tr.text.includes("line49"));
  const sw = crush("the cat sat on the mat", { mode: "web", algorithms: ["stopwords"] });
  pass("stopwords removes filler", !/\bthe\b/.test(sw.text) && sw.text.includes("cat"));
  const sm = crush(
    "Cats are great. Cats purr loudly. The weather is nice today. Cats sleep a lot. Cats are independent animals.",
    { algorithms: ["summarize"], summaryRatio: 0.4 },
  );
  pass("summarize keeps salient sentences", sm.text.length < 110 && /Cats/.test(sm.text));

  // --- savings metrics sane ---
  const big = crush("<div>" + "x ".repeat(200) + "</div>", { mode: "web" });
  pass("savings metrics computed", big.savedPercent >= 0 && big.crushedTokens <= big.originalTokens);

  // --- LRU cache bound (set env before import won't help; test relative behavior) ---
  const before = stats().cachedRefs;
  crush("unique-" + Date.now(), { mode: "web" });
  pass("cache grows + stats tracks", stats().cachedRefs >= before && stats().calls > 0);

  // --- mapper: scan this project's src (offline) ---
  const map = await scanCodebase(__dirname.replace(/build$/, "src"));
  pass("scanCodebase finds files", map.fileCount > 0 && map.astFiles > 0);
  pass("scanCodebase builds edges", map.edges.length > 0);
  pass("scanCodebase clusters", map.analysis.communityCount >= 1);
  pass("scanCodebase confidence labels", map.edges.some((e) => e.confidence === "EXTRACTED"));

  // --- mapper: ast-grep multi-language (offline, temp fixtures) ---
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mm-unit-"));
  await fs.writeFile(path.join(dir, "a.py"), "def foo():\n    return 1\nclass Bar:\n    pass\n");
  await fs.writeFile(path.join(dir, "b.rs"), "fn main() { foo(); }\nstruct Cfg { n: i32 }\n");
  const m2 = await scanCodebase(dir);
  const syms = m2.nodes.filter((n) => n.kind === "symbol").map((n) => n.label);
  pass("ast-grep python+rust symbols", syms.includes("foo") && syms.includes("Bar") && syms.includes("Cfg"),
    `[${syms.join(",")}]`);
  await fs.rm(dir, { recursive: true, force: true });

  // --- mermaid export ---
  pass("exportMermaid produces graph", exportMermaid(map).startsWith("graph LR"));

  console.log(failures ? `\n${failures} unit test(s) failed.\n` : "\nAll unit tests passed.\n");
  if (failures) process.exit(1);
}

main().catch((e) => {
  console.error("test-unit fatal:", e);
  process.exit(1);
});
