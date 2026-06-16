# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

_Nothing yet._

## [1.1.0] - 2026-06-16

Compression-first release. Token compression is now the headline capability,
with persistence, a budget interface, and real benchmarks.

### Added

- **Persistent reversible store** (`src/store.ts`) — originals and lifetime
  savings now persist to disk under `MESHMIND_HOME` (default `~/.meshmind`), so
  a `ref` survives process restarts and stats accumulate across sessions.
  Dependency-free (plain JSON files), LRU-bounded, and fail-soft to in-memory if
  the disk is unavailable.
- **Token-budget mode** — `get_optimized_context` and `crush_file` accept
  `targetTokens`; MeshMind progressively escalates the pipeline (lossless-ish →
  stopwords → summarize → truncate) until the output fits, and reports the
  escalation log. "Tell it how many tokens you have; it gets you there."
- **`crush_file` tool** — read a file and compress it (optionally to a budget)
  in a single call.
- **Preview mode** — `preview: true` returns a per-algorithm savings breakdown
  without storing a ref or touching stats.
- **`context_stats` now reports `session` + `lifetime`** totals (calls, tokens,
  percent saved, cached refs, first/last seen).
- **Benchmark harness** (`npm run benchmark`) — reproducible compression
  benchmarks on representative payloads (logs, JSON, HTML, source, RAG) with
  exact BPE tokens, percent saved, timings, and budget-mode accuracy.

### Changed

- `stats()` now returns `{ session, lifetime }` instead of a flat object.
- Server version bumped to 1.1.0; tool count is now 7.

## [1.0.0] - 2026-06-15

Initial public release — [`meshmind` on npm](https://www.npmjs.com/package/meshmind).
A single MCP server merging three context-engineering pillars.

### Added

- **`scan_local_codebase` / `export_codebase_graph`** — dependency graph with
  real AST extraction (TypeScript compiler API for TS/JS, ast-grep for
  Python/Go/Rust), inferred call graph with `EXTRACTED/INFERRED/AMBIGUOUS`
  confidence labels, community clustering, and structural analysis (hub nodes,
  import cycles, orphans). Mermaid + JSON export. *(← graphify)*
- **`research_last_30_days`** — recency research across 12 keyless sources
  (Hacker News, Reddit, GitHub, GitHub Issues, Web, Lobsters, Bluesky, Stack
  Overflow, Lemmy, Dev.to, Mastodon, YouTube) with relevance reranking, dedupe,
  algorithmic entity extraction, and cross-source theme fusion. Fail-soft per
  source. *(← last30days-skill)*
- **`get_optimized_context` / `retrieve_context` / `context_stats`** — reversible
  token compression with exact BPE counts (`gpt-tokenizer`), composable
  algorithms (strip, whitespace, line-dedup, json-min, truncate, stopwords,
  summarize), host-LLM abstractive summarization via MCP sampling with an
  extractive fallback, an LRU-bounded cache, and cumulative savings stats.
  *(← headroom)*
- Deterministic offline test suite plus opt-in live network tests, GitHub
  Actions CI on Node 18/20/22, MIT license, attribution (`CREDITS.md`), and a
  security policy (`SECURITY.md`).
- ESLint (flat config) + Prettier with `lint` / `format` / `format:check`
  scripts, enforced in CI; `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md`.

[Unreleased]: https://github.com/AntoniovanDijck/meshmind/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/AntoniovanDijck/meshmind/releases/tag/v1.0.0
