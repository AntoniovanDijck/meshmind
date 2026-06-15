/**
 * mapper.ts — Local codebase mapping (expanded).
 *
 * Conceptualized from `graphify`: collect → extract → build_graph → cluster →
 * analyze → report → export. Still dependency-free (regex, not tree-sitter), but
 * now produces a real graph: symbol nodes + edges with confidence labels, a
 * second-pass call graph, community clustering, structural analysis (god nodes,
 * cycles, orphans), and exports (graph.json + Mermaid).
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { extractAstGrep, supports as astGrepSupports } from "./astgrep.js";

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".rb", ".php", ".c", ".h", ".cpp", ".hpp",
  ".cs", ".swift", ".kt", ".scala", ".lua", ".sh", ".vue", ".svelte",
]);

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "build", "dist", ".next", "target", "venv", ".venv",
  "__pycache__", ".cache", "coverage", ".idea", ".vscode", "vendor", "out",
]);

const SENSITIVE = [
  /(^|[\\/])\.(env|envrc)(\.|$)/i,
  /\.(pem|key|p12|pfx|cert|crt|der|p8)$/i,
  /(\.netrc|\.pgpass|\.htpasswd)$/i,
];

/** Confidence labels, mirroring graphify. */
export type Confidence = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

export interface FileNode {
  path: string;
  ext: string;
  lines: number;
  imports: string[];
  symbols: string[];
}

export interface GraphNode {
  id: string;          // `path::symbol` or `path` for file nodes
  label: string;
  kind: "file" | "symbol";
  file: string;
  community?: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  relation: "imports" | "calls" | "declares";
  confidence: Confidence;
}

export interface Analysis {
  godNodes: { id: string; degree: number }[];  // highest fan-in/out
  orphans: string[];                            // files nothing imports & that import nothing local
  cycles: string[][];                           // import cycles (file level)
  communityCount: number;
  surprises: string[];                          // human-readable observations
}

export interface CodebaseMap {
  root: string;
  scannedAt: string;
  fileCount: number;
  astFiles: number;        // files parsed with a real AST (TS/JS) vs. regex
  totalLines: number;
  byLanguage: Record<string, number>;
  files: FileNode[];
  dependencies: Record<string, string[]>;
  nodes: GraphNode[];
  edges: GraphEdge[];
  analysis: Analysis;
}

export interface ScanOptions {
  maxFiles?: number;
  maxFileBytes?: number;
}

function isSensitive(p: string): boolean {
  return SENSITIVE.some((re) => re.test(p));
}

async function collectFiles(root: string, opts: Required<ScanOptions>): Promise<string[]> {
  const found: string[] = [];
  async function walk(dir: string): Promise<void> {
    if (found.length >= opts.maxFiles) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (found.length >= opts.maxFiles) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
        await walk(full);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!CODE_EXTENSIONS.has(ext)) continue;
        if (isSensitive(full)) continue;
        found.push(full);
      }
    }
  }
  await walk(root);
  return found;
}

const IMPORT_PATTERNS: RegExp[] = [
  /\bimport\s+(?:[\w*${}\s,]+\s+from\s+)?["']([^"']+)["']/g,
  /\brequire\(\s*["']([^"']+)["']\s*\)/g,
  /\bfrom\s+([\w.]+)\s+import\b/g,
  /^\s*import\s+([\w.]+)/gm,
  /^\s*use\s+([\w:]+)/gm,
];

const SYMBOL_PATTERNS: RegExp[] = [
  /\b(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  /\b(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/g,
  /^\s*def\s+([A-Za-z_]\w*)/gm,
  /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/gm,
  /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/g,
  /\b(?:type|struct|interface|enum)\s+([A-Za-z_$][\w$]*)/g,
];

function extractAll(patterns: RegExp[], text: string): string[] {
  const hits = new Set<string>();
  for (const re of patterns) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[1]) hits.add(m[1]);
    }
  }
  return [...hits];
}

const TS_JS_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

interface Extraction { imports: string[]; symbols: string[]; calls: string[]; }

/** Accurate AST extraction for TS/JS via the TypeScript compiler API. */
function extractTsAst(content: string, ext: string): Extraction {
  const scriptKind =
    ext === ".tsx" || ext === ".jsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile("f" + ext, content, ts.ScriptTarget.Latest, true, scriptKind);

  const imports = new Set<string>();
  const symbols = new Set<string>();
  const calls = new Set<string>();

  const visit = (node: ts.Node): void => {
    // imports
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.add(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      imports.add(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    ) {
      imports.add((node.arguments[0] as ts.StringLiteral).text);
    }

    // top-level-ish declarations (any depth — name is what matters for the graph)
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      symbols.add(node.name.text);
    } else if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) {
      symbols.add(node.name.text);
    } else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        symbols.add(node.name.text);
      }
    }

    // real call expressions → callee name (foo() or obj.foo())
    if (ts.isCallExpression(node)) {
      const e = node.expression;
      if (ts.isIdentifier(e)) calls.add(e.text);
      else if (ts.isPropertyAccessExpression(e)) calls.add(e.name.text);
    }

    ts.forEachChild(node, visit);
  };
  visit(sf);

  return { imports: [...imports], symbols: [...symbols], calls: [...calls] };
}

/** Regex extraction for non-TS/JS languages (broad, lower precision). */
function extractRegex(content: string): Extraction {
  const calls = new Set<string>();
  // Generic call sites: identifier immediately followed by "(".
  const callRe = /\b([A-Za-z_]\w{2,})\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = callRe.exec(content)) !== null) calls.add(m[1]);
  return {
    imports: extractAll(IMPORT_PATTERNS, content),
    symbols: extractAll(SYMBOL_PATTERNS, content),
    calls: [...calls],
  };
}

interface RawFile extends FileNode { content: string; calls: string[]; ast: boolean; }

async function extractFile(full: string, root: string, maxBytes: number): Promise<RawFile | null> {
  let raw: string;
  try {
    const stat = await fs.stat(full);
    if (stat.size > maxBytes) return null;
    raw = await fs.readFile(full, "utf8");
  } catch {
    return null;
  }
  const ext = path.extname(full).toLowerCase();
  // TS/JS → TS compiler API; Python/Go/Rust → ast-grep; everything else → regex.
  let ex: Extraction;
  let ast = false;
  try {
    if (TS_JS_EXT.has(ext)) {
      ex = extractTsAst(raw, ext);
      ast = true;
    } else if (astGrepSupports(ext)) {
      const g = extractAstGrep(raw, ext);
      if (g) { ex = g; ast = true; } else { ex = extractRegex(raw); }
    } else {
      ex = extractRegex(raw);
    }
  } catch {
    ex = extractRegex(raw); // any AST path blew up — degrade gracefully
    ast = false;
  }
  return {
    path: path.relative(root, full),
    ext,
    lines: raw.split("\n").length,
    imports: ex.imports,
    symbols: ex.symbols,
    calls: ex.calls,
    content: raw,
    ast,
  };
}

function resolveLocalImport(fromFile: string, spec: string, index: Set<string>): string | null {
  if (!spec.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), spec));
  // ESM/NodeNext imports reference the *emitted* extension (`./crusher.js`) while
  // the source on disk is `./crusher.ts`. Map JS-family extensions back to TS.
  const tsRemap = base.replace(/\.(js|jsx|mjs|cjs)$/, "");
  const candidates = [
    base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.jsx`, `${base}.mjs`,
    `${base}.py`, `${base}.go`, `${base}.rs`, `${base}/index.ts`, `${base}/index.js`,
    `${tsRemap}.ts`, `${tsRemap}.tsx`,
  ];
  return candidates.find((c) => index.has(c)) ?? null;
}

/* ---- clustering: label propagation over the file import graph ----------- */
function clusterFiles(files: string[], deps: Record<string, string[]>): Map<string, number> {
  // Build undirected adjacency.
  const adj = new Map<string, Set<string>>();
  for (const f of files) adj.set(f, new Set());
  for (const [src, targets] of Object.entries(deps)) {
    for (const t of targets) {
      adj.get(src)?.add(t);
      adj.get(t)?.add(src);
    }
  }
  // Initialize each node to its own community, then propagate the min label of
  // its neighborhood until stable (connected components, deterministic).
  const label = new Map<string, number>();
  files.forEach((f, i) => label.set(f, i));
  let changed = true;
  let guard = 0;
  while (changed && guard++ < files.length + 5) {
    changed = false;
    for (const f of files) {
      let min = label.get(f)!;
      for (const n of adj.get(f) ?? []) min = Math.min(min, label.get(n)!);
      if (min !== label.get(f)) {
        label.set(f, min);
        changed = true;
      }
    }
  }
  // Compact labels to 0..k.
  const remap = new Map<number, number>();
  let next = 0;
  for (const f of files) {
    const l = label.get(f)!;
    if (!remap.has(l)) remap.set(l, next++);
    label.set(f, remap.get(l)!);
  }
  return label;
}

/* ---- analysis: god nodes, cycles, orphans ------------------------------- */
function detectCycles(deps: Record<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const seen = new Set<string>();

  function dfs(node: string, stack: string[], onStack: Set<string>): void {
    onStack.add(node);
    stack.push(node);
    for (const next of deps[node] ?? []) {
      if (onStack.has(next)) {
        const idx = stack.indexOf(next);
        if (idx >= 0) cycles.push(stack.slice(idx).concat(next));
      } else if (!seen.has(next)) {
        dfs(next, stack, onStack);
      }
    }
    onStack.delete(node);
    stack.pop();
    seen.add(node);
  }

  for (const node of Object.keys(deps)) {
    if (!seen.has(node)) dfs(node, [], new Set());
  }
  // Dedup cycles by their sorted signature.
  const uniq = new Map<string, string[]>();
  for (const c of cycles) {
    const sig = [...c].sort().join("|");
    if (!uniq.has(sig)) uniq.set(sig, c);
  }
  return [...uniq.values()];
}

function analyze(
  files: FileNode[],
  deps: Record<string, string[]>,
  communities: Map<string, number>,
): Analysis {
  // Degree = fan-out + fan-in across file import edges.
  const degree = new Map<string, number>();
  const inDeg = new Map<string, number>();
  for (const f of files) {
    degree.set(f.path.split(path.sep).join("/"), 0);
  }
  for (const [src, targets] of Object.entries(deps)) {
    degree.set(src, (degree.get(src) ?? 0) + targets.length);
    for (const t of targets) {
      degree.set(t, (degree.get(t) ?? 0) + 1);
      inDeg.set(t, (inDeg.get(t) ?? 0) + 1);
    }
  }
  const godNodes = [...degree.entries()]
    .filter(([, d]) => d > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([id, d]) => ({ id, degree: d }));

  const orphans = files
    .map((f) => f.path.split(path.sep).join("/"))
    .filter((p) => !(p in deps) && !inDeg.has(p));

  const cycles = detectCycles(deps);

  const surprises: string[] = [];
  if (cycles.length) surprises.push(`${cycles.length} import cycle(s) detected.`);
  if (godNodes[0] && godNodes[0].degree >= 5)
    surprises.push(`Hub module: ${godNodes[0].id} (degree ${godNodes[0].degree}).`);
  if (orphans.length)
    surprises.push(`${orphans.length} orphan file(s) with no local import edges.`);

  return {
    godNodes,
    orphans,
    cycles,
    communityCount: new Set(communities.values()).size,
    surprises,
  };
}

/* ---- main scan ---------------------------------------------------------- */
export async function scanCodebase(rootInput: string, options: ScanOptions = {}): Promise<CodebaseMap> {
  const opts: Required<ScanOptions> = {
    maxFiles: options.maxFiles ?? 2000,
    maxFileBytes: options.maxFileBytes ?? 1_000_000,
  };
  const root = path.resolve(rootInput);
  const filePaths = await collectFiles(root, opts);

  const raw: RawFile[] = [];
  for (const fp of filePaths) {
    const node = await extractFile(fp, root, opts.maxFileBytes);
    if (node) raw.push(node);
  }

  const toPosix = (p: string) => p.split(path.sep).join("/");
  const index = new Set(raw.map((n) => toPosix(n.path)));

  const dependencies: Record<string, string[]> = {};
  const byLanguage: Record<string, number> = {};
  let totalLines = 0;

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  // Map symbol name -> declaring file (first declaration wins) for call graph.
  const symbolOwner = new Map<string, string>();

  for (const n of raw) {
    const pp = toPosix(n.path);
    totalLines += n.lines;
    byLanguage[n.ext] = (byLanguage[n.ext] ?? 0) + 1;

    nodes.push({ id: pp, label: path.basename(pp), kind: "file", file: pp });
    for (const sym of n.symbols) {
      const id = `${pp}::${sym}`;
      nodes.push({ id, label: sym, kind: "symbol", file: pp });
      edges.push({ source: pp, target: id, relation: "declares", confidence: "EXTRACTED" });
      if (!symbolOwner.has(sym)) symbolOwner.set(sym, id);
    }

    const deps: string[] = [];
    for (const spec of n.imports) {
      const local = resolveLocalImport(pp, spec, index);
      if (local) {
        deps.push(local);
        edges.push({ source: pp, target: local, relation: "imports", confidence: "EXTRACTED" });
      }
    }
    if (deps.length) dependencies[pp] = [...new Set(deps)];
  }

  // Second pass — call edges from real call sites (AST for TS/JS, regex
  // elsewhere). A file that invokes a symbol declared in another file gets a
  // `calls` edge. Confidence: EXTRACTED when both endpoints come from the AST,
  // INFERRED for regex-derived calls, AMBIGUOUS when the name is declared in
  // multiple files (resolution is uncertain without full type binding).
  const symbolCounts = new Map<string, number>();
  for (const n of raw) for (const s of n.symbols) symbolCounts.set(s, (symbolCounts.get(s) ?? 0) + 1);

  for (const n of raw) {
    const pp = toPosix(n.path);
    const own = new Set(n.symbols);
    for (const called of n.calls) {
      if (own.has(called)) continue;             // local call, no cross-file edge
      if (called.length < 3) continue;           // too generic
      const ownerId = symbolOwner.get(called);
      if (!ownerId) continue;                     // not a project symbol
      const multi = (symbolCounts.get(called) ?? 1) > 1;
      edges.push({
        source: pp,
        target: ownerId,
        relation: "calls",
        confidence: multi ? "AMBIGUOUS" : n.ast ? "EXTRACTED" : "INFERRED",
      });
    }
  }

  const files: FileNode[] = raw.map(({ content, calls, ast, ...f }) => f);
  const astCount = raw.filter((r) => r.ast).length;
  const communities = clusterFiles([...index], dependencies);
  for (const node of nodes) {
    const c = communities.get(node.file);
    if (c !== undefined) node.community = c;
  }
  const analysisResult = analyze(files, dependencies, communities);

  return {
    root,
    scannedAt: new Date().toISOString(),
    fileCount: files.length,
    astFiles: astCount,
    totalLines,
    byLanguage,
    files,
    dependencies,
    nodes,
    edges,
    analysis: analysisResult,
  };
}

/* ---- report + exports --------------------------------------------------- */
export function renderMapSummary(map: CodebaseMap): string {
  const langs = Object.entries(map.byLanguage)
    .sort((a, b) => b[1] - a[1])
    .map(([ext, n]) => `${ext}:${n}`)
    .join(" ");

  const lines: string[] = [
    `# Codebase Map — ${map.root}`,
    `files=${map.fileCount} (ast=${map.astFiles}) lines=${map.totalLines} ` +
      `symbols=${map.nodes.filter((n) => n.kind === "symbol").length} ` +
      `edges=${map.edges.length} communities=${map.analysis.communityCount} langs=[${langs}]`,
    ``,
    `## Analysis`,
  ];
  if (map.analysis.surprises.length) {
    for (const s of map.analysis.surprises) lines.push(`- ⚠️  ${s}`);
  } else {
    lines.push(`- No structural surprises.`);
  }
  if (map.analysis.godNodes.length) {
    lines.push(`- Hubs: ${map.analysis.godNodes.map((g) => `${g.id}(${g.degree})`).join(", ")}`);
  }
  if (map.analysis.cycles.length) {
    for (const c of map.analysis.cycles.slice(0, 5)) lines.push(`- Cycle: ${c.join(" → ")}`);
  }

  lines.push(``, `## Files`);
  for (const f of map.files) {
    const syms = f.symbols.slice(0, 8).join(",");
    lines.push(`- ${f.path} (${f.lines}L)${syms ? ` :: ${syms}` : ""}`);
  }
  const depKeys = Object.keys(map.dependencies);
  if (depKeys.length) {
    lines.push(``, `## Local dependencies`);
    for (const k of depKeys) lines.push(`- ${k} -> ${map.dependencies[k].join(", ")}`);
  }
  const calls = map.edges.filter((e) => e.relation === "calls");
  if (calls.length) {
    lines.push(``, `## Call graph (inferred)`);
    for (const e of calls.slice(0, 40)) {
      lines.push(`- ${e.source} → ${e.target} [${e.confidence}]`);
    }
  }
  return lines.join("\n");
}

/** Export the file-level dependency graph as a Mermaid diagram. */
export function exportMermaid(map: CodebaseMap): string {
  const id = (p: string) => "n" + Math.abs([...p].reduce((a, c) => (a * 31 + c.charCodeAt(0)) | 0, 7));
  const lines = ["graph LR"];
  const seen = new Set<string>();
  for (const f of map.files) {
    const pp = f.path.split(path.sep).join("/");
    if (!seen.has(pp)) {
      lines.push(`  ${id(pp)}["${path.basename(pp)}"]`);
      seen.add(pp);
    }
  }
  for (const [src, targets] of Object.entries(map.dependencies)) {
    for (const t of targets) lines.push(`  ${id(src)} --> ${id(t)}`);
  }
  return lines.join("\n");
}

/** Export nodes+edges as graph.json (Obsidian/D3-friendly shape). */
export function exportGraphJson(map: CodebaseMap): string {
  return JSON.stringify(
    {
      root: map.root,
      scannedAt: map.scannedAt,
      nodes: map.nodes,
      edges: map.edges,
      analysis: map.analysis,
    },
    null,
    2,
  );
}
