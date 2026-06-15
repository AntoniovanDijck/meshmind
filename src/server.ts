#!/usr/bin/env node
/**
 * server.ts — meshmind MCP server.
 *
 * Unifies three pillars behind one MCP surface, now with the supporting tools
 * each mother project exposes:
 *   - scan_local_codebase      (mapper.ts        ← graphify)
 *   - export_codebase_graph    (mapper.ts        ← graphify export)
 *   - research_last_30_days    (recency_engine   ← last30days-skill)
 *   - get_optimized_context    (crusher.ts       ← headroom compress)
 *   - retrieve_context         (crusher.ts       ← headroom retrieve / CCR)
 *   - context_stats            (crusher.ts       ← headroom stats)
 *
 * research_last_30_days can pipe its output straight through the crusher
 * (`compress: true`) so the LLM never reads uncompressed payloads.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { promises as fs } from "node:fs";

import { crush, retrieve, stats, countTokens, CrushMode, Algorithm } from "./crusher.js";
import { scanCodebase, renderMapSummary, exportMermaid, exportGraphJson } from "./mapper.js";
import {
  research,
  researchToText,
  Source,
  ResearchOptions,
  ALL_SOURCES,
} from "./recency_engine.js";

const server = new McpServer({ name: "meshmind", version: "1.0.0" });

const SOURCE_ENUM = ALL_SOURCES as [Source, ...Source[]];
const ALGO_ENUM = [
  "strip",
  "whitespace",
  "line-dedup",
  "json-min",
  "truncate",
  "stopwords",
  "summarize",
] as const;

function textContent(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

/**
 * Abstractive summary via MCP sampling — delegates to the host LLM instead of a
 * bundled ONNX model. Returns null if the client doesn't support sampling, so
 * the caller can fall back to the extractive `summarize` algorithm.
 */
async function summarizeViaHost(text: string): Promise<string | null> {
  try {
    const res = await server.server.createMessage({
      maxTokens: 600,
      systemPrompt:
        "You compress context for another AI agent. Rewrite the input as the " +
        "shortest faithful summary that preserves every concrete fact, name, " +
        "number, and decision. No preamble, no markdown headers — just the summary.",
      messages: [{ role: "user", content: { type: "text", text } }],
    });
    const out = res?.content;
    if (out && out.type === "text" && out.text.trim()) return out.text.trim();
    return null;
  } catch {
    return null; // client has no sampling capability — fall back to extractive
  }
}

/* ---- Tool 1: scan_local_codebase ---------------------------------------- */
server.registerTool(
  "scan_local_codebase",
  {
    title: "Scan local codebase",
    description:
      "Recursively scan a directory and build a dependency graph: files, " +
      "top-level symbols, import edges, an inferred call graph (with " +
      "EXTRACTED/INFERRED/AMBIGUOUS confidence), community clustering, and " +
      "structural analysis (hub/god nodes, import cycles, orphans). Default " +
      "returns a compact summary; raw=true returns the full JSON map.",
    inputSchema: {
      path: z.string().describe("Absolute or relative directory to scan."),
      raw: z.boolean().optional().describe("Return full JSON map instead of summary."),
      maxFiles: z.number().int().positive().optional(),
    },
  },
  async ({ path: dir, raw, maxFiles }) => {
    const map = await scanCodebase(dir, maxFiles ? { maxFiles } : {});
    return textContent(raw ? JSON.stringify(map, null, 2) : renderMapSummary(map));
  },
);

/* ---- Tool 2: export_codebase_graph -------------------------------------- */
server.registerTool(
  "export_codebase_graph",
  {
    title: "Export codebase graph",
    description:
      "Scan a directory and export its dependency graph as either a Mermaid " +
      "diagram (format='mermaid') or a D3/Obsidian-friendly nodes+edges JSON " +
      "(format='json').",
    inputSchema: {
      path: z.string().describe("Directory to scan and export."),
      format: z.enum(["mermaid", "json"]).optional().describe("Output format (default mermaid)."),
    },
  },
  async ({ path: dir, format }) => {
    const map = await scanCodebase(dir);
    return textContent(format === "json" ? exportGraphJson(map) : exportMermaid(map));
  },
);

/* ---- Tool 3: research_last_30_days -------------------------------------- */
server.registerTool(
  "research_last_30_days",
  {
    title: "Research the last 30 days",
    description:
      "Fetch recent community/social signal on a topic from keyless public " +
      "sources (Hacker News + comment enrichment, Reddit w/ RSS fallback, " +
      "GitHub, Web, Lobsters, Bluesky, Stack Overflow, Lemmy), filtered to a " +
      "trailing window. Results are relevance-reranked and deduped. Set " +
      "compress=true to pipe the result through the token-reduction pipeline.",
    inputSchema: {
      topic: z.string().describe("Topic or query to research."),
      windowDays: z.number().int().positive().optional().describe("Trailing window (default 30)."),
      sources: z
        .array(z.enum(SOURCE_ENUM))
        .optional()
        .describe("Subset of sources (default: all)."),
      perSource: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Max items per source (default 10)."),
      compress: z.boolean().optional().describe("Pipe output through get_optimized_context."),
    },
  },
  async ({ topic, windowDays, sources, perSource, compress }) => {
    const opts: ResearchOptions = {};
    if (windowDays) opts.windowDays = windowDays;
    if (sources) opts.sources = sources as Source[];
    if (perSource) opts.perSource = perSource;

    const result = await research(topic, opts);
    const raw = researchToText(result);

    if (compress) {
      const crushed = crush(raw, "web");
      const header =
        `[meshmind] compressed research: ${crushed.originalTokens}→` +
        `${crushed.crushedTokens} tokens (-${crushed.savedPercent}%) | ref=${crushed.ref}\n\n`;
      return textContent(header + crushed.text);
    }
    return textContent(raw);
  },
);

/* ---- Tool 4: get_optimized_context -------------------------------------- */
server.registerTool(
  "get_optimized_context",
  {
    title: "Get optimized (compressed) context",
    description:
      "Reversible token-reduction pipeline. Accepts raw `text` OR a `filePath`. " +
      "Composable algorithms: strip (comments/HTML), whitespace, line-dedup, " +
      "json-min, truncate (first/last-K keep), stopwords, summarize (extractive). " +
      "Set summarize=true for an abstractive summary via the host LLM (MCP " +
      "sampling), with extractive as fallback. Returns the compressed payload, " +
      "exact BPE savings, and a `ref` usable with retrieve_context to recover " +
      "the original. Provide exactly one of `text` or `filePath`.",
    inputSchema: {
      text: z.string().optional().describe("Raw text/code/HTML to compress."),
      filePath: z.string().optional().describe("Local file to read and compress."),
      mode: z
        .enum(["code", "web", "auto"])
        .optional()
        .describe("Compression regime (default auto)."),
      algorithms: z
        .array(z.enum(ALGO_ENUM))
        .optional()
        .describe("Override the algorithm pipeline."),
      maxLines: z.number().int().positive().optional().describe("truncate: line budget."),
      summarize: z
        .boolean()
        .optional()
        .describe("Abstractive summary via host LLM (sampling), extractive fallback."),
    },
  },
  async ({ text, filePath, mode, algorithms, maxLines, summarize }) => {
    if (!text && !filePath) return textContent("Error: provide either `text` or `filePath`.");
    let input = text ?? "";
    if (filePath) {
      try {
        input = await fs.readFile(filePath, "utf8");
      } catch (e) {
        return textContent(`Error reading ${filePath}: ${String((e as Error).message)}`);
      }
    }

    // Baseline crush. If summarize requested, append extractive summarize as the
    // guaranteed local result.
    const algos =
      (algorithms as Algorithm[] | undefined) ??
      (summarize
        ? (["strip", "whitespace", "line-dedup", "json-min", "summarize"] as Algorithm[])
        : undefined);
    const r = crush(input, { mode: (mode ?? "auto") as CrushMode, algorithms: algos, maxLines });

    let body = r.text;
    let note = "";
    let crushedTokens = r.crushedTokens;

    if (summarize) {
      const abstractive = await summarizeViaHost(r.text);
      if (abstractive) {
        body = abstractive;
        crushedTokens = countTokens(abstractive);
        note = " | summary=abstractive(host-llm)";
      } else {
        note = " | summary=extractive(fallback)";
      }
    }

    const savedPercent =
      r.originalTokens > 0
        ? Math.round(((r.originalTokens - crushedTokens) / r.originalTokens) * 1000) / 10
        : 0;
    const header =
      `[meshmind] mode=${r.mode} algos=[${r.algorithms.join(",")}] ` +
      `${r.originalTokens}→${crushedTokens} tokens (-${savedPercent}%) | ` +
      `${r.originalChars}→${body.length} chars | ref=${r.ref}${note}\n\n`;
    return textContent(header + body);
  },
);

/* ---- Tool 5: retrieve_context ------------------------------------------- */
server.registerTool(
  "retrieve_context",
  {
    title: "Retrieve original (uncompressed) context",
    description:
      "Recover the original, uncompressed text for a `ref` returned by a prior " +
      "get_optimized_context or compressed research call (reversible / CCR).",
    inputSchema: { ref: z.string().describe("The cf_… ref to recover.") },
  },
  async ({ ref }) => {
    const original = retrieve(ref);
    return textContent(original ?? `No cached original for ref=${ref} (evicted or unknown).`);
  },
);

/* ---- Tool 6: context_stats ---------------------------------------------- */
server.registerTool(
  "context_stats",
  {
    title: "Compression stats",
    description:
      "Return cumulative token-savings stats for this server session: total " +
      "compress calls, original vs. crushed tokens, percent saved, cached refs.",
    inputSchema: {},
  },
  async () => textContent(JSON.stringify(stats(), null, 2)),
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write("meshmind MCP server running on stdio\n");
}

main().catch((err) => {
  process.stderr.write(`meshmind fatal: ${String(err)}\n`);
  process.exit(1);
});
