import { createRequire } from "node:module";
import path from "node:path";
import { Language, type Node, Parser } from "web-tree-sitter";

/**
 * Minimal Python parsing for extractor tests. Production never parses here —
 * core injects its already-parsed trees — so this helper is test-only.
 */

const require = createRequire(import.meta.url);

let python: Language | null = null;

export async function parsePython(source: string): Promise<Node> {
  if (!python) {
    await Parser.init();
    const pkgJson = require.resolve("tree-sitter-wasms/package.json");
    python = await Language.load(
      path.join(path.dirname(pkgJson), "out", "tree-sitter-python.wasm"),
    );
  }
  const parser = new Parser();
  parser.setLanguage(python);
  const tree = parser.parse(source);
  if (!tree) throw new Error("tree-sitter returned no tree");
  return tree.rootNode;
}
