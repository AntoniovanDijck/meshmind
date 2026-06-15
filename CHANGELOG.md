# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- ESLint (flat config) + Prettier with `lint` / `format` / `format:check`
  scripts, enforced in CI.
- `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and this changelog.

## [1.0.0] - 2026-06-15

Initial release — a single MCP server merging three context-engineering pillars.

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

[Unreleased]: https://github.com/AntoniovanDijck/meshmind/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/AntoniovanDijck/meshmind/releases/tag/v1.0.0
