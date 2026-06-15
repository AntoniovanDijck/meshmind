# Contributing to MeshMind

Thanks for your interest in improving MeshMind! This project is a single MCP
server with three pillars — codebase mapping, recency research, and token
compression. Contributions of all sizes are welcome.

## Development setup

```bash
git clone https://github.com/AntoniovanDijck/meshmind.git
cd meshmind
npm install
npm run build
npm test            # offline unit + MCP integration tests
```

- **Node ≥ 18** is required.
- The codebase is TypeScript (ESM, `Node16` module resolution). Source lives in
  `src/`, compiled output in `build/`.

## Before you open a PR

Run the full local check — CI runs the same steps on Node 18/20/22:

```bash
npm run lint          # eslint
npm run format:check  # prettier (run `npm run format` to auto-fix)
npm run build         # must compile clean
npm test              # offline suite must pass
```

Live network sources are **opt-in** so the default suite stays deterministic.
If your change touches `recency_engine.ts`, also run:

```bash
npm run test:network
```

## Project conventions

- **Match the surrounding style** — comment density, naming, and idioms. Files
  carry a header comment noting which upstream project the pillar derives from.
- **Fail soft** in `recency_engine.ts`: a dead source must return `[]`, never
  throw and sink the whole run.
- **No heavy runtime dependencies.** Prefer the Node stdlib or delegating to the
  host LLM (via MCP sampling) over bundling models. See `CREDITS.md` for the
  design philosophy.
- **Reversibility**: anything lossy in `crusher.ts` must remain retrievable via
  the cache ref.

## Adding things

- **A new compression algorithm** → add it to the `Algorithm` union in
  `crusher.ts`, implement a pure function, wire it into the pipeline switch, and
  add a unit test in `test-unit.ts`.
- **A new research source** → add a keyless fetcher in `recency_engine.ts`,
  register it in `FETCHERS` and `ALL_SOURCES`, and keep it fail-soft.
- **A new language for the mapper** → extend `astgrep.ts` (install the
  `@ast-grep/lang-*` grammar) or the TS-compiler path in `mapper.ts`.

## Reporting bugs / requesting features

Open a [GitHub issue](https://github.com/AntoniovanDijck/meshmind/issues) with a
clear description and, for bugs, a minimal reproduction. For security issues,
follow [`SECURITY.md`](SECURITY.md) instead of filing a public issue.

## License

By contributing, you agree that your contributions are licensed under the
project's [MIT License](LICENSE).
