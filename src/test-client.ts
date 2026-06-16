/**
 * test-client.ts — Mock MCP client that boots the meshmind server over a
 * real stdio transport and exercises every tool. Run via `npm test`.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(__dirname, "server.js");

function firstText(res: any): string {
  return res?.content?.find((c: any) => c.type === "text")?.text ?? "";
}

function pass(name: string, ok: boolean, detail = "") {
  console.log(`${ok ? "✅ PASS" : "❌ FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) process.exitCode = 1;
}

async function main() {
  // Isolate the server's persistent store in a temp dir.
  const TEST_HOME = path.join(os.tmpdir(), `mm-itest-home-${process.pid}`);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    env: { ...process.env, MESHMIND_HOME: TEST_HOME },
  });
  const client = new Client({ name: "meshmind-test", version: "1.0.0" });
  await client.connect(transport);

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  console.log("\nRegistered tools:", names.join(", "), "\n");
  pass(
    "seven tools registered",
    names.length >= 7 &&
      [
        "context_stats",
        "crush_file",
        "export_codebase_graph",
        "get_optimized_context",
        "research_last_30_days",
        "retrieve_context",
        "scan_local_codebase",
      ].every((n) => names.includes(n)),
  );

  // --- get_optimized_context (code) ---
  const codeSample = `
// this comment should vanish
import { x } from "./y";
/* a block comment */
function   hello(name)   { return    "hi " + name; }
export const z = 1;
`;
  const codeRes = await client.callTool({
    name: "get_optimized_context",
    arguments: { text: codeSample, mode: "code" },
  });
  const codeOut = firstText(codeRes);
  const codeRef = (codeOut.match(/ref=(cf_\w+)/) || [])[1] ?? "";
  pass(
    "get_optimized_context strips code comments + returns ref",
    !codeOut.includes("should vanish") &&
      !codeOut.includes("block comment") &&
      codeOut.includes("function") &&
      codeRef.startsWith("cf_"),
    codeOut.split("\n")[0],
  );

  // --- retrieve_context (reversibility) ---
  const retRes = await client.callTool({ name: "retrieve_context", arguments: { ref: codeRef } });
  const retOut = firstText(retRes);
  pass(
    "retrieve_context recovers the original",
    retOut.includes("should vanish") && retOut.includes("block comment"),
  );

  // --- line-dedup algorithm ---
  const dupRes = await client.callTool({
    name: "get_optimized_context",
    arguments: { text: "ERR x\nERR x\nERR x\nok\nok\n", mode: "code", algorithms: ["line-dedup"] },
  });
  const dupOut = firstText(dupRes);
  pass(
    "line-dedup collapses repeats",
    dupOut.includes("(x3)") && dupOut.includes("(x2)"),
    dupOut.split("\n")[0],
  );

  // --- get_optimized_context (web) ---
  const htmlSample = `<html><head><style>.a{color:red}</style></head>
  <body><nav>Home About</nav><p>Real &amp; useful content here.</p><script>track();</script></body></html>`;
  const webRes = await client.callTool({
    name: "get_optimized_context",
    arguments: { text: htmlSample, mode: "web" },
  });
  const webOut = firstText(webRes);
  pass(
    "get_optimized_context strips HTML boilerplate",
    webOut.includes("Real & useful content") &&
      !webOut.includes("track()") &&
      !webOut.includes("color:red"),
    webOut.split("\n")[0],
  );

  // --- stopwords algorithm (prose filler removal) ---
  const swRes = await client.callTool({
    name: "get_optimized_context",
    arguments: {
      text: "This is a summary of the results and it is very useful.",
      mode: "web",
      algorithms: ["stopwords"],
    },
  });
  const swOut = firstText(swRes);
  pass(
    "stopwords drops filler words",
    !/\bthe\b/i.test(swOut.split("\n\n")[1] ?? swOut) &&
      swOut.includes("summary") &&
      swOut.includes("results"),
    swOut.split("\n")[0],
  );

  // --- scan_local_codebase (real AST graph + analysis) ---
  const scanRes = await client.callTool({
    name: "scan_local_codebase",
    arguments: { path: path.join(__dirname, "..", "src") },
  });
  const scanOut = firstText(scanRes);
  const fa = scanOut.match(/files=(\d+) \(ast=(\d+)\)/);
  const allTsAreAst = !!fa && fa[1] === fa[2]; // every .ts file parsed via AST
  pass(
    "scan_local_codebase builds AST graph + analysis",
    scanOut.includes("crusher.ts") &&
      scanOut.includes("communities=") &&
      allTsAreAst &&
      scanOut.includes("## Analysis") &&
      scanOut.includes("Call graph") &&
      scanOut.includes("[EXTRACTED]"),
    scanOut.split("\n")[1],
  );

  // --- scan_local_codebase with ast-grep (Python + Go) ---
  const fixDir = await fs.mkdtemp(path.join(os.tmpdir(), "omni-ctx-"));
  await fs.writeFile(
    path.join(fixDir, "util.py"),
    "def helper(x):\n    return x * 2\n\nclass Widget:\n    pass\n",
  );
  await fs.writeFile(
    path.join(fixDir, "main.py"),
    "from util import helper\n\ndef run():\n    return helper(21)\n",
  );
  await fs.writeFile(
    path.join(fixDir, "svc.go"),
    "package main\nfunc Serve() int { return Compute() }\nfunc Compute() int { return 42 }\n",
  );
  const pyRes = await client.callTool({
    name: "scan_local_codebase",
    arguments: { path: fixDir, raw: true },
  });
  const pyMap = JSON.parse(firstText(pyRes));
  const hasPyCall = pyMap.edges.some(
    (e: any) =>
      e.relation === "calls" && e.target.includes("helper") && e.confidence === "EXTRACTED",
  );
  const goSymbols = pyMap.nodes
    .filter((n: any) => n.kind === "symbol" && n.file.endsWith("svc.go"))
    .map((n: any) => n.label);
  const hasGoSyms = goSymbols.includes("Serve") && goSymbols.includes("Compute");
  pass(
    "ast-grep extracts Python + Go symbols/calls",
    pyMap.astFiles === 3 && hasPyCall && hasGoSyms,
    `astFiles=${pyMap.astFiles} pyCall=${hasPyCall} goSyms=[${goSymbols.join(",")}]`,
  );
  await fs.rm(fixDir, { recursive: true, force: true });

  // --- summarize (extractive fallback; sampling unsupported in test client) ---
  const longProse =
    Array.from(
      { length: 8 },
      (_, i) =>
        `Sentence ${i} discusses the omni context server and its compression pipeline in detail.`,
    ).join(" ") + " The critical fact is that the build passed and all tests are green.";
  const sumRes = await client.callTool({
    name: "get_optimized_context",
    arguments: { text: longProse, mode: "web", summarize: true },
  });
  const sumOut = firstText(sumRes);
  pass(
    "summarize reduces prose (extractive fallback)",
    sumOut.includes("summary=extractive(fallback)") && sumOut.length < longProse.length,
    sumOut.split("\n")[0],
  );

  // --- export_codebase_graph (mermaid) ---
  const expRes = await client.callTool({
    name: "export_codebase_graph",
    arguments: { path: path.join(__dirname, "..", "src"), format: "mermaid" },
  });
  const expOut = firstText(expRes);
  pass(
    "export_codebase_graph emits Mermaid",
    expOut.startsWith("graph LR") && expOut.includes("-->"),
  );

  // --- get_optimized_context with targetTokens (budget mode) ---
  const budgetText = Array.from(
    { length: 300 },
    (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog repeatedly and verbosely`,
  ).join("\n");
  const budgetRes = await client.callTool({
    name: "get_optimized_context",
    arguments: { text: budgetText, targetTokens: 120 },
  });
  const budgetOut = firstText(budgetRes);
  const budgetTok = Number(
    (budgetOut.match(/→ (\d+) tok ✓/) || budgetOut.match(/→ (\d+) tok/) || [])[1],
  );
  pass(
    "get_optimized_context honors targetTokens",
    budgetOut.includes("budget=120") &&
      budgetOut.includes("Escalation:") &&
      budgetTok > 0 &&
      budgetTok <= 120,
    budgetOut.split("\n")[0],
  );

  // --- preview mode (per-step breakdown, no ref) ---
  const prevRes = await client.callTool({
    name: "get_optimized_context",
    arguments: {
      text: "// drop\n\n\nconst a = 1;\n\n\nconst b = 2;\n",
      mode: "code",
      preview: true,
    },
  });
  const prevOut = firstText(prevRes);
  pass(
    "preview shows per-step breakdown without a ref",
    prevOut.includes("PREVIEW (not stored)") &&
      prevOut.includes("Per-step breakdown") &&
      !prevOut.includes("ref=cf_"),
    prevOut.split("\n")[0],
  );

  // --- crush_file (read + compress in one call, to a budget) ---
  const tmpFile = path.join(os.tmpdir(), `mm-crushfile-${process.pid}.log`);
  await fs.writeFile(
    tmpFile,
    Array.from({ length: 200 }, (_, i) => `2026-06-16 ERROR retry ${i} connection timed out`).join(
      "\n",
    ),
  );
  const cfRes = await client.callTool({
    name: "crush_file",
    arguments: { path: tmpFile, targetTokens: 60 },
  });
  const cfOut = firstText(cfRes);
  pass(
    "crush_file reads + compresses to budget + returns ref",
    cfOut.includes("budget=60") && cfOut.includes("ref=cf_") && cfOut.includes(tmpFile),
    cfOut.split("\n")[0],
  );
  await fs.rm(tmpFile, { force: true });

  // --- context_stats (session + lifetime) ---
  const statRes = await client.callTool({ name: "context_stats", arguments: {} });
  const statOut = JSON.parse(firstText(statRes));
  pass(
    "context_stats reports session + lifetime savings",
    statOut.session?.calls >= 3 &&
      statOut.session?.cachedRefs >= 1 &&
      typeof statOut.session?.savedPercent === "number" &&
      typeof statOut.lifetime?.calls === "number" &&
      typeof statOut.lifetime?.firstSeen === "string",
    `session.calls=${statOut.session?.calls} lifetime.calls=${statOut.lifetime?.calls}`,
  );

  // --- research_last_30_days (live; opt-in via RUN_NETWORK_TESTS=1) ---
  if (!process.env.RUN_NETWORK_TESTS) {
    console.log("⏭️  research_last_30_days skipped (set RUN_NETWORK_TESTS=1 to run live)");
  } else
    try {
      const resRes = await client.callTool({
        name: "research_last_30_days",
        arguments: {
          topic: "model context protocol",
          sources: ["hackernews", "lobsters"],
          perSource: 5,
          compress: true,
        },
      });
      const resOut = firstText(resRes);
      pass(
        "research_last_30_days returns compressed payload",
        resOut.includes("compressed research") && resOut.includes("ref=cf_"),
        resOut.split("\n")[0],
      );

      // entities + themes surface in an uncompressed run
      const rawResRes = await client.callTool({
        name: "research_last_30_days",
        arguments: {
          topic: "rust programming",
          sources: ["hackernews", "lobsters", "reddit"],
          perSource: 6,
        },
      });
      const rawResOut = firstText(rawResRes);
      pass(
        "research surfaces entities + fused themes",
        rawResOut.includes("## Key entities") && rawResOut.includes("## Themes"),
        (rawResOut.split("\n").find((l) => l.includes("Key entities")) ?? "").slice(0, 40),
      );
    } catch (e) {
      console.log(`⚠️  research_last_30_days skipped (network): ${String((e as Error).message)}`);
    }

  await client.close();
  await fs.rm(TEST_HOME, { recursive: true, force: true }).catch(() => {});
  console.log(process.exitCode ? "\nSome tests failed.\n" : "\nAll tests passed.\n");
}

main().catch((e) => {
  console.error("test-client fatal:", e);
  process.exit(1);
});
