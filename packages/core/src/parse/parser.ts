import { createRequire } from "node:module";
import path from "node:path";
import { Language, Parser } from "web-tree-sitter";

/**
 * web-tree-sitter (WASM) setup. WASM over native bindings is a deliberate
 * choice: zero node-gyp, works on every platform Node runs on, and the
 * ~2-3x parse slowdown is amortized by the content-hash cache.
 *
 * Grammars come from `tree-sitter-wasms` resolved out of node_modules.
 * When the CLI gets bundled (Phase 6) they will be vendored into dist/ and
 * this resolution function is the single place to change.
 */

export type GrammarName = "typescript" | "tsx" | "javascript" | "python";

const require = createRequire(import.meta.url);

function grammarPath(name: GrammarName): string {
  const pkgJson = require.resolve("tree-sitter-wasms/package.json");
  return path.join(path.dirname(pkgJson), "out", `tree-sitter-${name}.wasm`);
}

let initialized = false;
const languages = new Map<GrammarName, Language>();

export async function initParser(): Promise<void> {
  if (initialized) return;
  await Parser.init();
  initialized = true;
}

export async function loadLanguage(name: GrammarName): Promise<Language> {
  await initParser();
  let lang = languages.get(name);
  if (!lang) {
    lang = await Language.load(grammarPath(name));
    languages.set(name, lang);
  }
  return lang;
}

export function grammarForFile(relPath: string): GrammarName | null {
  const ext = path.extname(relPath).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".mts":
    case ".cts":
      return "typescript";
    case ".tsx":
      return "tsx";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".py":
      return "python";
    default:
      return null;
  }
}

export async function parseSource(name: GrammarName, source: string) {
  const lang = await loadLanguage(name);
  const parser = new Parser();
  parser.setLanguage(lang);
  const tree = parser.parse(source);
  if (!tree) throw new Error(`tree-sitter returned no tree (grammar: ${name})`);
  return { tree, lang };
}
