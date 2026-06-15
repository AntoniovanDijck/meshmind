# MeshMind

A single MCP server that merges three context-engineering ideas into one toolset
for AI agents:

| Pillar | Mother repo | What it does here |
|--------|-------------|-------------------|
| Local codebase mapping | **graphify** | Recursive scan → lightweight dependency map (files, symbols, import edges) |
| Recency research | **last30days-skill** | Keyless fetch of last-N-days signal from Hacker News, Reddit, GitHub, Web |
| Token compression | **headroom** | Regex crusher that strips code comments / HTML & markdown boilerplate |

Everything an agent reads can be funneled through the crusher first, so the LLM
never pays for uncompressed, token-heavy payloads.

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

First clone & build, then point your client at the built server:

```bash
git clone https://github.com/AntoniovanDijck/meshmind.git
cd meshmind
npm install && npm run build
```

This produces the runnable server at `build/server.js`. In the snippets below,
replace `/ABS/PATH/TO/meshmind` with the absolute path where you cloned it
(run `pwd` in the repo to get it).

MeshMind speaks stdio, so any MCP-compatible client works. The command is always
the same — `node /ABS/PATH/TO/meshmind/build/server.js` — only the config
location/format differs per client.

**Claude Code** (CLI — registers it for you):

```bash
claude mcp add meshmind -- node /ABS/PATH/TO/meshmind/build/server.js
```

**Cursor** — `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project):

```json
{
  "mcpServers": {
    "meshmind": { "command": "node", "args": ["/ABS/PATH/TO/meshmind/build/server.js"] }
  }
}
```

**Claude Desktop** — `claude_desktop_config.json` (macOS:
`~/Library/Application Support/Claude/`, Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "meshmind": { "command": "node", "args": ["/ABS/PATH/TO/meshmind/build/server.js"] }
  }
}
```

**VS Code** (Copilot/MCP) — `.vscode/mcp.json`:

```json
{
  "servers": {
    "meshmind": { "type": "stdio", "command": "node", "args": ["/ABS/PATH/TO/meshmind/build/server.js"] }
  }
}
```

Any other MCP host (Codex, Gemini CLI, Windsurf, Zed, …) uses the same
`command` + `args` pair in its own config format. See
[`mcp.example.json`](mcp.example.json) for the canonical block.

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
