# 🕸️ MeshMind

[![npm](https://img.shields.io/npm/v/meshmind.svg)](https://www.npmjs.com/package/meshmind)
[![CI](https://github.com/AntoniovanDijck/meshmind/actions/workflows/ci.yml/badge.svg)](https://github.com/AntoniovanDijck/meshmind/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/meshmind.svg)](LICENSE)
[![node](https://img.shields.io/node/v/meshmind.svg)](https://nodejs.org)

**One MCP server. Three superpowers for your AI agent — keyless, local-first, no setup.**

> Built for **AI engineers, senior devs, and power users** who want their coding agent to understand large codebases, stay current with fast-moving topics, and stop wasting the context window.

---

## 🎬 See it in action

Ask your agent in plain language — MeshMind picks the right tool:

```
You:    "Map this repo and show me hub modules and import cycles."

Agent:  Scanning 87 files… (AST: 71, regex: 16)
        📦 4 communities detected
        🔗 Hub nodes: server.ts (degree 12), mapper.ts (degree 9)
        ⚠️  Import cycle: crusher.ts → server.ts → crusher.ts
        Summary: 312 edges, 6 orphan files, 2 god nodes
```

```
You:    "What's the latest on Bun vs Node in the last 30 days?"

Agent:  Researched 12 sources (847 results → 42 after fusion + dedup)
        🔥 Top corroborated theme: Bun 1.2 HTTP perf benchmarks
           Sources: HN (score 847), Reddit r/javascript, Dev.to (3 posts)
        📌 Entities: Bun, Node 22, Deno, WinterTC
        💡 Diverging signal: GitHub issues show Node winning on compatibility
```

```
You:    "This log file is 8k lines — compress it before reading."

Agent:  get_optimized_context → line-dedup + truncate
        8,143 tokens → 1,204 tokens  (85% saved)
        ref: cf_a3f9… (retrieve anytime to get the original back)
```

---

## ⚡ Three superpowers

```
🧭 MAP YOUR CODE          📰 RESEARCH WHAT'S NEW       🗜️ CRUSH THE TOKENS
─────────────────────     ──────────────────────────    ─────────────────────────
Real AST dependency       Last-N-days signal from       Reversible compression
& call graph              12 keyless public sources     with exact BPE counts

TS/JS via TypeScript      HN · Reddit · GitHub          7 composable algorithms
compiler API              Lobsters · Bluesky            strip · dedup · truncate
                          Stack Overflow · Lemmy        json-min · stopwords
Python/Go/Rust via        Dev.to · Mastodon             summarize (host LLM)
ast-grep/tree-sitter      YouTube (via Piped)

Community clustering      Cross-source fusion           LRU-bounded reversible
Cycle/hub detection       Relevance reranking           cache — get originals
Mermaid/JSON export       Entity extraction             back anytime via ref
```

The killer combo: pipe research output **straight through the compressor** — agent reads the signal, not the token bill.

---

## 🎯 Who this is for

**Use MeshMind if you are:**
- An AI engineer or developer who uses Claude Code, Cursor, or a similar coding agent daily
- Working on large or unfamiliar codebases where the agent needs structural context fast
- Researching fast-moving topics (new frameworks, API changes, community debates) without paying for search APIs
- Hitting context window limits and want reversible, measurable compression

**When NOT to use MeshMind:**
- You need **real-time data** (research window is 30 days by default, not live search)
- You need **authenticated sources** (all 12 sources are public/keyless — no paywalled content)
- You need **code execution or modification** (MeshMind is read-only: maps, reads, compresses)
- Your codebase is **gigantic** (100k+ files) — use `maxFiles` to scope it, or a dedicated code-index tool

---

## ⚡ Quick start (60 seconds)

```bash
# Claude Code — one command, done:
claude mcp add meshmind -- npx -y meshmind
```

No API keys. No build step. `npx` fetches it on first run. For other clients see [Install in an MCP client](#install-in-an-mcp-client) below.

---

## 🔒 Security & privacy

**Everything runs locally. Nothing is stored. Nothing is sent to third parties.**

- **Codebase mapping** — reads files on your machine, builds graph in memory, returns summary. No data leaves the process.
- **Research** — fetches public URLs (HN, Reddit, GitHub, etc.) the same way your browser would. No auth tokens required or stored.
- **Compression** — runs entirely in-process. The `ref` cache is in-memory only and cleared when the process exits.
- **Summarization** — when `summarize: true`, your text is sent to your **own MCP client's LLM** via standard MCP sampling (i.e. the same model your agent already uses). If your client doesn't support sampling, MeshMind falls back to local extractive summarization — nothing leaves the process.

MeshMind intentionally skips `.env` files, secrets-pattern filenames, `node_modules`, and dotdirs during codebase scans. Full threat model: [`SECURITY.md`](SECURITY.md).

---

## Tools

### `scan_local_codebase`

`{ path, raw?, maxFiles? }` — dependency graph with real AST extraction.

- **TS/JS/TSX/JSX** — TypeScript compiler API (true AST, not regex)
- **Python, Go, Rust** — ast-grep / tree-sitter grammars
- **Everything else** — regex fallback
- Edges carry `EXTRACTED / INFERRED / AMBIGUOUS` confidence labels
- Community clustering (label propagation), hub/god node detection, import cycle detection, orphan detection
- Skips `node_modules`, build dirs, dotdirs, secrets-pattern files
- Default: compact summary with `ast=N` coverage; `raw: true` returns full JSON

**Example output:**
```json
{
  "fileCount": 87,
  "astFiles": 71,
  "edges": 312,
  "analysis": {
    "hubs": ["server.ts", "mapper.ts"],
    "cycles": [["crusher.ts", "server.ts"]],
    "orphans": ["legacy/old-api.ts"],
    "communityCount": 4
  }
}
```

---

### `export_codebase_graph`

`{ path, format? }` — export the dependency graph.

- `"mermaid"` — paste directly into docs, GitHub, or Obsidian
- `"json"` — nodes + edges for D3, Obsidian Canvas, or custom tooling

**Example Mermaid output:**
```
graph LR
  server.ts --> mapper.ts
  server.ts --> crusher.ts
  mapper.ts --> astgrep.ts
  crusher.ts -.-> server.ts
```

---

### `research_last_30_days`

`{ topic, windowDays?, sources?, perSource?, compress? }` — multi-source community signal.

- **12 keyless sources:** `hackernews`, `reddit`, `github`, `github_issues`, `web`, `lobsters`, `bluesky`, `stackoverflow`, `lemmy`, `devto`, `mastodon`, `youtube`
- Entity extraction — surfaces salient names, libs, keywords
- Cross-source fusion — clusters results into themes, boosts items corroborated by ≥2 independent sources
- Fail-soft — a blocked source returns nothing instead of crashing the run
- `compress: true` — pipes result through the crusher before returning

**Example output (truncated):**
```json
{
  "topic": "Bun vs Node",
  "totalResults": 42,
  "themes": [
    {
      "label": "Bun 1.2 HTTP performance benchmarks",
      "sources": ["hackernews", "reddit", "devto"],
      "topItem": { "title": "Bun 1.2 is faster than Node on HTTP", "score": 847 }
    }
  ],
  "entities": ["Bun", "Node 22", "Deno", "WinterTC"]
}
```

---

### `get_optimized_context`

`{ text? | filePath?, mode?, algorithms?, maxLines?, summarize? }` — reversible compression.

- Returns: compressed text + `ref` + exact BPE token counts + `savedPercent`
- **Algorithms (composable):** `strip` · `whitespace` · `line-dedup` · `json-min` · `truncate` · `stopwords` · `summarize`
- **Modes:** `code` · `web` · `auto`
- `summarize: true` — delegates to host LLM via MCP sampling; falls back to local extractive

**Example output:**
```json
{
  "ref": "cf_a3f9b2…",
  "originalTokens": 8143,
  "crushedTokens": 1204,
  "savedPercent": 85.2,
  "text": "…compressed content…"
}
```

---

### `retrieve_context`

`{ ref }` — recover the original uncompressed text from a `ref`.

LRU-bounded cache (default 500 entries). Tune via `MESHMIND_CACHE_MAX` env var.

---

### `context_stats`

`{}` — cumulative session savings.

```json
{
  "calls": 14,
  "originalTokens": 84200,
  "crushedTokens": 12300,
  "savedPercent": 85.4,
  "cachedRefs": 14
}
```

---

## Recipes

| You say… | MeshMind does… |
|---|---|
| "Map this repo and flag hub modules and import cycles." | `scan_local_codebase` → AST graph + analysis |
| "Export the dependency graph as Mermaid so I can paste it in the docs." | `export_codebase_graph` → Mermaid |
| "What did people say about `bun` vs `node` in the last 30 days?" | `research_last_30_days` → ranked, fused, multi-source digest |
| "Research Rust async, but compress it before you read it." | `research_last_30_days` with `compress: true` |
| "This stack trace is huge — dedupe and trim it before reading." | `get_optimized_context` with `line-dedup` + `truncate` |
| "Summarize this 20-page doc into the key facts." | `get_optimized_context` with `summarize: true` (host-LLM) |
| "Give me back the full original of that compressed blob." | `retrieve_context` with the `ref` |
| "How many tokens have we saved this session?" | `context_stats` |

**Tip:** chain them. "Research X, compress it, and tell me the 3 corroborated themes" hits research → fusion → compression in one turn, and the agent only reads the crushed output.

---

## Install in an MCP client

MeshMind is on npm: <https://www.npmjs.com/package/meshmind>. No clone or build needed — `npx` fetches and runs it. The command is always `npx -y meshmind`; only the config location differs per client.

**Claude Code** (CLI — registers it for you):

```bash
claude mcp add meshmind -- npx -y meshmind
```

**Cursor** — `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "meshmind": { "command": "npx", "args": ["-y", "meshmind"] }
  }
}
```

**Claude Desktop** — `claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "meshmind": { "command": "npx", "args": ["-y", "meshmind"] }
  }
}
```

**VS Code** (Copilot/MCP) — `.vscode/mcp.json`:

```json
{
  "servers": {
    "meshmind": { "type": "stdio", "command": "npx", "args": ["-y", "meshmind"] }
  }
}
```

Any other MCP host (Codex, Gemini CLI, Windsurf, Zed, …) uses the same `command` + `args` pair in its own config format. See [`mcp.example.json`](mcp.example.json) for the canonical block.

Prefer a pinned global binary? `npm i -g meshmind`, then use `meshmind` as the command instead of `npx -y meshmind`.

### From source (for development)

```bash
git clone https://github.com/AntoniovanDijck/meshmind.git
cd meshmind
npm install && npm run build   # runnable server at build/server.js
```

Then point the client at `node /ABS/PATH/TO/meshmind/build/server.js`.

---

## Build & test

```bash
npm install
npm run build          # tsc → build/
npm test               # offline: unit tests + MCP integration (no network)
npm run test:network   # also exercises the live research sources
```

Live network sources are **opt-in** (`RUN_NETWORK_TESTS=1`) so the default suite is deterministic and CI-safe.

---

## Architecture

```
src/
  crusher.ts          # compression pipeline + reversible cache     ← headroom
  mapper.ts           # collect → extract → graph → cluster/analyze ← graphify
  astgrep.ts          # multi-language AST (Python/Go/Rust)         ← graphify
  recency_engine.ts   # parallel keyless source fetchers + fusion   ← last30days
  server.ts           # MCP server: registers the 6 tools
  test-unit.ts        # deterministic offline unit tests
  test-client.ts      # MCP integration tests over stdio
```

Runtime dependencies: `@modelcontextprotocol/sdk`, `zod`, `gpt-tokenizer` (exact BPE counts), `typescript` (TS/JS AST), `@ast-grep/napi` + `@ast-grep/lang-{python,go,rust}` (multi-language AST). Networking uses the Node stdlib `fetch`. Summarization delegates to the host LLM via MCP sampling — no ONNX, no model downloads.

---

## FAQ

**Do I need any API keys?**
No. Every research source is keyless/public, and compression + mapping are fully local.

**Which languages does the codebase mapper understand?**
TS/JS/TSX/JSX via the TypeScript compiler API. Python, Go, Rust via ast-grep (tree-sitter). Everything else falls back to regex. The summary's `ast=N` tells you how many files got a real AST.

**Is the compression lossy? Can I get the original back?**
Lossy steps exist (strip, dedupe, summarize), but every compression is stored under a `ref`. Call `retrieve_context` with that `ref` to recover the exact original (LRU-bounded, default 500 entries — tune via `MESHMIND_CACHE_MAX`).

**A research source returned nothing / errored.**
Sources are fail-soft: a blocked or rate-limited source returns nothing instead of crashing the run. The result lists per-source errors so you know what was skipped.

**Does `summarize` send my data anywhere?**
Only to your own MCP client's LLM, via standard MCP sampling. If the client doesn't support sampling, MeshMind falls back to local extractive summarization. See [`SECURITY.md`](SECURITY.md).

**Can it read files outside my project?**
It reads whatever path you give it, with the privileges of the process. Run it in a sandbox if you need to constrain that — details in [`SECURITY.md`](SECURITY.md).

**Why "MeshMind"?**
It meshes three separate context tools into one mind for your agent. 🕸️🧠

---

## Credits & License

MeshMind is MIT-licensed. Its three pillars are *conceptually* derived from
[graphify](https://github.com/safishamsi/graphify),
[headroom](https://github.com/chopratejas/headroom), and
[last30days-skill](https://github.com/mvanhorn/last30days-skill) — see
[`CREDITS.md`](CREDITS.md) for full attribution. Contributions welcome — see
[`CONTRIBUTING.md`](CONTRIBUTING.md).
