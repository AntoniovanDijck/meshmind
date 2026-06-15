/**
 * astgrep.ts — Multi-language AST extraction via ast-grep (tree-sitter under
 * the hood), for the languages the TypeScript compiler API can't parse.
 *
 * TS/JS stay on the TS compiler API (mapper.ts). Here we cover Python, Go, and
 * Rust through dynamically-registered ast-grep grammars. One native package
 * (@ast-grep/napi) + per-language grammar packages, registered once. If the
 * native binary is unavailable on a platform, callers fall back to regex.
 */

import { registerDynamicLanguage, parse } from "@ast-grep/napi";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

export interface Extraction { imports: string[]; symbols: string[]; calls: string[]; }

let ready = false;
let available = false;

/** Register grammars once. Safe to call repeatedly. */
function ensureRegistered(): boolean {
  if (ready) return available;
  ready = true;
  try {
    // The lang packages export the descriptor object directly (CJS, no .default).
    const python = require("@ast-grep/lang-python");
    const go = require("@ast-grep/lang-go");
    const rust = require("@ast-grep/lang-rust");
    registerDynamicLanguage({ python, go, rust });
    available = true;
  } catch {
    available = false;
  }
  return available;
}

const EXT_TO_LANG: Record<string, string> = {
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
};

/** Node kinds per language: [functions/types, calls-field, import scaffolding]. */
interface LangSpec {
  declKinds: string[];     // kinds whose `name` field is a declared symbol
  callKind: string;        // call expression kind
  callField: string;       // field on the call node holding the callee
  importKinds: string[];   // statements that contain module specifiers
}

const SPECS: Record<string, LangSpec> = {
  python: {
    declKinds: ["function_definition", "class_definition"],
    callKind: "call",
    callField: "function",
    importKinds: ["import_statement", "import_from_statement"],
  },
  go: {
    declKinds: ["function_declaration", "method_declaration", "type_spec"],
    callKind: "call_expression",
    callField: "function",
    importKinds: ["import_declaration"],
  },
  rust: {
    declKinds: ["function_item", "struct_item", "enum_item", "trait_item", "type_item"],
    callKind: "call_expression",
    callField: "function",
    importKinds: ["use_declaration"],
  },
};

/** Last identifier of a dotted/path callee: `a.b.c`/`a::b::c` → `c`. */
function lastSegment(text: string): string {
  const parts = text.split(/::|\./).map((s) => s.trim()).filter(Boolean);
  return parts[parts.length - 1] ?? text;
}

export function supports(ext: string): boolean {
  return ext in EXT_TO_LANG && ensureRegistered();
}

/** Extract imports/symbols/calls for a supported non-TS/JS file. */
export function extractAstGrep(content: string, ext: string): Extraction | null {
  if (!ensureRegistered()) return null;
  const lang = EXT_TO_LANG[ext];
  if (!lang) return null;
  const spec = SPECS[lang];

  let root;
  try {
    root = parse(lang as any, content).root();
  } catch {
    return null;
  }

  const symbols = new Set<string>();
  for (const kind of spec.declKinds) {
    for (const node of root.findAll({ rule: { kind } })) {
      const name = node.field("name")?.text();
      if (name) symbols.add(name);
    }
  }

  const calls = new Set<string>();
  for (const node of root.findAll({ rule: { kind: spec.callKind } })) {
    const callee = node.field(spec.callField)?.text();
    if (callee) calls.add(lastSegment(callee));
  }

  // Imports: pull string-literal / dotted module specifiers inside import nodes.
  const imports = new Set<string>();
  for (const kind of spec.importKinds) {
    for (const node of root.findAll({ rule: { kind } })) {
      const raw = node.text();
      // module paths appear as "quoted" (Go), dotted.name (Python), or a::b (Rust)
      const quoted = raw.match(/"([^"]+)"/g);
      if (quoted) for (const q of quoted) imports.add(q.replace(/"/g, ""));
      const dotted = raw.match(/(?:from|import|use)\s+([A-Za-z_][\w.:]*)/);
      if (dotted) imports.add(dotted[1]);
    }
  }

  return { imports: [...imports], symbols: [...symbols], calls: [...calls] };
}
