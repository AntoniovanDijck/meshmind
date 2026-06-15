# 🕸️ MeshMind

[![npm](https://img.shields.io/npm/v/meshmind.svg)](https://www.npmjs.com/package/meshmind)
[![CI](https://github.com/AntoniovanDijck/meshmind/actions/workflows/ci.yml/badge.svg)](https://github.com/AntoniovanDijck/meshmind/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/meshmind.svg)](LICENSE)
[![node](https://img.shields.io/node/v/meshmind.svg)](https://nodejs.org)

**One MCP server. Three superpowers for your AI agent: map code, research the
last 30 days, and crush tokens — all keyless, all local-first.**

MeshMind gives any MCP-compatible agent (Claude Code, Cursor, Claude Desktop,
VS Code, …) three tightly-integrated capabilities behind a single install:

| 🧭 Map your code | 📰 Research what's new | 🗜️ Crush the tokens |
|---|---|---|
| Real-AST dependency & call graph (TS/JS via the TypeScript compiler, Python/Go/Rust via ast-grep), clustering, cycle/hub analysis | Last-N-days signal from **12 keyless sources** (HN, Reddit, GitHub, Lobsters, Bluesky, Stack Overflow, Lemmy, Dev.to, Mastodon, YouTube…), reranked + fused across sources | Reversible compression with **exact BPE token counts**, 7 algorithms, and host-LLM summarization — no model downloads |
| *(idea ← graphify)* | *(idea ← last30days-skill)* | *(idea ← headroom)* |

The killer combo: research or file output can be piped **straight through the
compressor** before it ever reaches the LLM — so your agent reads the signal,
not the token bill. Everything is reversible: ask for the original back anytime.

## ⚡ Quick start (60 seconds)

```bash
# Claude Code — one command, done:
claude mcp add meshmind -- npx -y meshmind
```

Then just talk to your agent:

> *"Map this codebase and show me the hub modules and any import cycles."*
> *"What's the buzz about the Model Context Protocol in the last 30 days?"*
> *"Compress this 4k-line log file before you read it."*

No API keys. No build step. `npx` fetches it on first run. For other clients see
[Install in an MCP client](#install-in-an-mcp-client) below.

## Tools

### `scan_local_codebase`
`{ path, raw?, maxFiles? }` → dependency **graph** of a directory: files, symbols,
import edges, and a **call graph** from real call sites. **Real AST** parsing:
TS/JS via the **TypeScript compiler API**; **Python/Go/Rust via ast-grep**
(tree-sitter grammars). Other languages fall back to regex. Edges carry
`EXTRACTED/INFERRED/AMBIGUOUS` confidence. Adds **community clustering** (label
propagation) and structural **analysis** (hub/god nodes, import cycles, orphans).
Default returns a compact summary (`ast=N` shows AST coverage); `raw: true`
returns the full JSON map. Skips `node_modules`, build dirs, dotdirs, and files
that look like they hold secrets.

### `export_codebase_graph`
`{ path, format? }` → exports the dependency graph as a **Mermaid** diagram
(`format: "mermaid"`) or D3/Obsidian-friendly **nodes+edges JSON** (`"json"`).

### `research_last_30_days`
`{ topic, windowDays?, sources?, perSource?, compress? }` → community/social
signal from the trailing window, **relevance-reranked, deduped, and fused**. 12
keyless sources (no API tokens): `hackernews` (+ comment enrichment), `reddit`
(with an RSS fallback), `github`, `github_issues`, `web`, `lobsters`, `bluesky`,
`stackoverflow`, `lemmy`, `devto`, `mastodon`, `youtube` (via Piped mirrors).
**Entity extraction** surfaces salient names/keywords; **fusion** clusters results
into themes and flags those corroborated across ≥2 distinct sources (independent
communities = strong signal), boosting them in the ranking. Dead sources return
nothing instead of failing the run. `compress: true` pipes the result through
the crusher.

### `get_optimized_context`
`{ text? | filePath?, mode?, algorithms?, maxLines?, summarize? }` →
**reversible** compressed payload + **exact BPE token counts** (via
`gpt-tokenizer`) + a `ref`. Composable algorithms: `strip | whitespace |
line-dedup | json-min | truncate | stopwords | summarize`. `summarize: true`
delegates to the **host LLM via MCP sampling** for an abstractive summary
(no bundled model), with extractive summarization as the fallback. `mode`:
`code | web | auto`. Provide exactly one of `text` or `filePath`.

### `retrieve_context`
`{ ref }` → recovers the original uncompressed text for a `ref` returned by a
prior compress/research call (CCR-style reversibility).

### `context_stats`
`{}` → cumulative session savings: compress calls, original vs. crushed tokens,
percent saved, cached refs.

## Recipes

Once MeshMind is installed, you drive it in plain language — the agent picks the
tool. Some things to try:

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

**Tip:** chain them. "Research X, compress it, and tell me the 3 corroborated
themes" hits research → fusion → compression in one turn, and the agent only
reads the crushed output.

## Build & test

```bash
npm install
npm run build          # tsc → build/
npm test               # offline: unit tests + MCP integration (no network)
npm run test:network   # also exercises the live research sources
```

Live network sources are **opt-in** (`RUN_NETWORK_TESTS=1`) so the default
suite is deterministic and CI-safe.

## Install in an MCP client

MeshMind is on npm: <https://www.npmjs.com/package/meshmind>. No clone or build
needed — `npx` fetches and runs it. MeshMind speaks stdio, so any MCP-compatible
client works; the command is always `npx -y meshmind` and only the config
location/format differs per client.

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

**Claude Desktop** — `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

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

Any other MCP host (Codex, Gemini CLI, Windsurf, Zed, …) uses the same
`command` + `args` pair in its own config format. See
[`mcp.example.json`](mcp.example.json) for the canonical block.

Prefer a pinned global binary? `npm i -g meshmind`, then use `meshmind` as the
command instead of `npx -y meshmind`.

### From source (for development)

```bash
git clone https://github.com/AntoniovanDijck/meshmind.git
cd meshmind
npm install && npm run build   # runnable server at build/server.js
```

Then point the client at `node /ABS/PATH/TO/meshmind/build/server.js`.

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

Runtime dependencies: `@modelcontextprotocol/sdk`, `zod`, `gpt-tokenizer`
(exact BPE counts), `typescript` (TS/JS AST), and `@ast-grep/napi` +
`@ast-grep/lang-{python,go,rust}` (multi-language AST). Networking uses the Node
stdlib `fetch`. Semantic summarization is delegated to the host LLM via MCP
sampling rather than a bundled ML model — no ONNX, no model downloads.

## FAQ

**Do I need any API keys?**
No. Every research source is keyless/public, and compression + mapping are fully
local. The only "model" used is the one your MCP client already runs (for
optional `summarize`).

**Which languages does the codebase mapper understand?**
TS/JS/TSX/JSX get a true AST via the TypeScript compiler API. Python, Go, and
Rust get a true AST via ast-grep (tree-sitter). Other languages fall back to a
regex extractor. The summary's `ast=N` tells you how many files were parsed
with a real AST.

**Is the compression lossy? Can I get the original back?**
The strip/dedupe/summarize steps are lossy, but every compression is stored
under a `ref`. Call `retrieve_context` with that `ref` to recover the exact
original (LRU-bounded, default 500 entries — tune via `MESHMIND_CACHE_MAX`).

**A research source returned nothing / errored.**
Sources are *fail-soft* by design: a blocked or rate-limited source (e.g.,
Bluesky from a datacenter IP) returns nothing rather than failing the whole run.
The result lists per-source errors so you know what was skipped.

**Does `summarize` send my data anywhere?**
Only to your own MCP client's LLM, via standard MCP sampling. If the client
doesn't support sampling, MeshMind falls back to local extractive summarization
and nothing leaves the process. See [`SECURITY.md`](SECURITY.md).

**Can it read files outside my project?**
It reads whatever path you give it, with the privileges of the process. Run it in
a sandbox if you need to constrain that — details in [`SECURITY.md`](SECURITY.md).

**Why "MeshMind"?**
It meshes three separate context tools into one mind for your agent. 🕸️🧠

## Credits & License

MeshMind is MIT-licensed. Its three pillars are *conceptually* derived from
[graphify](https://github.com/safishamsi/graphify),
[headroom](https://github.com/chopratejas/headroom), and
[last30days-skill](https://github.com/mvanhorn/last30days-skill) — see
[`CREDITS.md`](CREDITS.md) for full attribution. Contributions welcome — see
[`CONTRIBUTING.md`](CONTRIBUTING.md).
