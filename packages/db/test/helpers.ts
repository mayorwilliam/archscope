import { createRequire } from "node:module";
import path from "node:path";
import { Language, type Node, Parser } from "web-tree-sitter";

/**
 * Minimal TS/Python parsing for extractor tests. Production never parses here —
 * core injects its already-parsed trees — so this helper is test-only.
 */

const require = createRequire(import.meta.url);

const languages = new Map<string, Language>();

async function parseWith(wasmFile: string, source: string): Promise<Node> {
  let language = languages.get(wasmFile);
  if (!language) {
    await Parser.init();
    const pkgJson = require.resolve("tree-sitter-wasms/package.json");
    language = await Language.load(path.join(path.dirname(pkgJson), "out", wasmFile));
    languages.set(wasmFile, language);
  }
  const parser = new Parser();
  parser.setLanguage(language);
  const tree = parser.parse(source);
  if (!tree) throw new Error("tree-sitter returned no tree");
  return tree.rootNode;
}

export async function parsePython(source: string): Promise<Node> {
  return parseWith("tree-sitter-python.wasm", source);
}

export async function parseTypescript(source: string): Promise<Node> {
  return parseWith("tree-sitter-typescript.wasm", source);
}
