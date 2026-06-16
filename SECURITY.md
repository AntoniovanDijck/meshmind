# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities by opening a
[GitHub security advisory](https://github.com/AntoniovanDijck/meshmind/security/advisories/new)
or a private issue. Do not disclose publicly until a fix is available. We aim to
acknowledge reports within 7 days.

## Threat model & operator notes

MeshMind is a **local, stdio-based MCP server**. It runs with the privileges of
the user/agent that launches it. Operators should understand the following
before exposing it to untrusted input or environments.

### Local filesystem access

`scan_local_codebase`, `export_codebase_graph`, and `get_optimized_context`
(via `filePath`) **read arbitrary paths** the host process can access. This is
intentional — the tool's job is to read local code — but it means a prompt that
controls the `path`/`filePath` argument can read any file the process can read.

- The mapper skips files matching known secret patterns (`.env`, `*.pem`,
  `*.key`, `.netrc`, …) and noise directories (`node_modules`, `.git`, build
  dirs), but this is a convenience filter, **not** a security boundary.
- To restrict access, run the server in a sandbox/container scoped to the
  project directory, or set a least-privilege user.

### Outbound network requests

`research_last_30_days` makes outbound HTTP requests to a **fixed allowlist** of
public, keyless endpoints (Hacker News, Reddit, GitHub, DuckDuckGo, Lobsters,
Bluesky, Stack Overflow, Lemmy, Dev.to, Mastodon, Piped). User input only forms
the *query string*, never the host — there is no server-side request forgery
(SSRF) surface to arbitrary hosts.

- Some sources are scraped (DuckDuckGo HTML, Piped mirrors). This may be subject
  to those services' terms of use and may break without notice. Sources fail
  soft (return nothing) rather than crashing the run.
- All requests carry a 20s timeout and a descriptive User-Agent.

### Host-LLM sampling

`get_optimized_context` with `summarize: true` issues an MCP **sampling**
request to the host client. The input text is sent to the host's configured LLM.
If the client does not support sampling, MeshMind silently falls back to local
extractive summarization — no data leaves the process.

### Persistent reversible store (data at rest)

As of v1.1, compressed originals are **persisted to disk** so a `ref` survives
process restarts. Operators should be aware:

- Originals are written under `MESHMIND_HOME` (default `~/.meshmind/originals/`)
  as plain JSON files, readable by the running user. They are **not encrypted**.
- This means text you compress — including anything sensitive you pass to
  `get_optimized_context` / `crush_file` — is stored on local disk until evicted.
- To opt out of persistence, set `MESHMIND_HOME` to a tmpfs/ephemeral path, or
  clear `~/.meshmind` between sessions. If the directory is not writable, the
  store fails soft to in-memory (originals never touch disk).
- The store is **local only** — nothing is ever transmitted off-machine.

### Resource bounds

- The reversible store is **LRU bounded** to `MESHMIND_CACHE_MAX` entries
  (default 500), evicting the least-recently-used originals to cap disk/memory.
- File scanning is capped by `maxFiles` (default 2000) and a per-file byte cap.

## Supported versions

The latest released minor version receives security fixes.
