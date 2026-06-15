# Credits & Attribution

MeshMind is an original TypeScript implementation, but its three pillars are
**conceptually derived from** three prior open-source projects. We gratefully
acknowledge them. MeshMind does not vendor or copy their source code; it
reimplements the *ideas* (the pipelines, the heuristics, the tool surfaces) in
a single MCP server. Where an algorithm or tool name mirrors one of these
projects, that lineage is noted in the relevant source file's header comment.

| Pillar in MeshMind | Inspired by | Upstream license |
|--------------------|-------------|------------------|
| `scan_local_codebase` / `export_codebase_graph` — codebase mapping, dependency/call graph, clustering, confidence labels | **graphify** | MIT |
| `get_optimized_context` / `retrieve_context` / `context_stats` — context compression, reversible cache (CCR), compress/retrieve/stats surface | **headroom** | Apache-2.0 |
| `research_last_30_days` — recency research, keyless sources, fail-soft fetching | **last30days-skill** | MIT |

## License compatibility

MeshMind is released under the **MIT License** (see `LICENSE`). All three
upstream projects use permissive licenses (MIT and Apache-2.0) that are
compatible with redistribution under MIT.

Because **headroom** is licensed under **Apache-2.0**, which carries an
attribution requirement, this file serves as the required notice of derivation.
No Apache-2.0-licensed source code is included in MeshMind; only the high-level
design concepts (e.g., the idea of a reversible compression cache and a
compress/retrieve/stats tool trio) were used as a reference.

## Runtime dependencies

MeshMind builds on these libraries (see `package.json` for versions):

- `@modelcontextprotocol/sdk` — MCP server/client (MIT)
- `gpt-tokenizer` — exact BPE token counting (MIT)
- `typescript` — TS/JS AST extraction via the compiler API (Apache-2.0)
- `@ast-grep/napi` + `@ast-grep/lang-{python,go,rust}` — multi-language AST (MIT)
- `zod` — input schema validation (MIT)

If you believe any attribution here is incomplete or incorrect, please open an
issue — we will correct it promptly.
