import { type DeclaredEntity, extractSqlalchemyEntities } from "@archmap/db";
import type { Lang, SymbolKind } from "@archmap/schema";
import type { Node } from "web-tree-sitter";
import type { FileFacts, ImportFact, SymbolFact } from "./facts.js";
import { parseSource } from "./parser.js";

/**
 * Python fact extraction. Imports are collected from the whole tree (Python
 * code imports inside functions routinely, e.g. to break cycles); symbols are
 * top-level only, mirroring the TS extractor's "API surface" rule.
 *
 * "Exported" for Python is convention-driven and deterministic: if the module
 * declares a static `__all__`, that list wins; otherwise every top-level name
 * not starting with `_` is public.
 */

export async function extractPyFacts(relPath: string, source: string): Promise<FileFacts> {
  const { tree } = await parseSource("python", source);
  const lang: Lang = "py";

  const imports: ImportFact[] = [];
  const symbols: SymbolFact[] = [];
  let allList: Set<string> | null = null;

  const root = tree.rootNode;

  for (const stmt of root.namedChildren) {
    if (!stmt) continue;
    switch (stmt.type) {
      case "function_definition":
        pushSymbol(symbols, stmt, "function");
        break;
      case "class_definition":
        pushSymbol(symbols, stmt, "class");
        break;
      case "decorated_definition": {
        const def = stmt.childForFieldName("definition");
        if (def?.type === "function_definition") pushSymbol(symbols, def, "function");
        else if (def?.type === "class_definition") pushSymbol(symbols, def, "class");
        break;
      }
      case "expression_statement": {
        for (const expr of stmt.namedChildren) {
          if (expr?.type !== "assignment") continue;
          const all = tryParseDunderAll(expr);
          if (all) allList = all;
          collectAssignmentTargets(expr, symbols);
        }
        break;
      }
      default:
        break;
    }
  }

  collectImports(root, imports);

  for (const sym of symbols) {
    sym.exported = allList ? allList.has(sym.name) : !sym.name.startsWith("_");
  }

  // `__tablename__` in the source is the deterministic SQLAlchemy-declarative
  // marker — cheaper and more robust than chasing the Base class through
  // imports (models often only import Base from a local module).
  let entities: DeclaredEntity[] = [];
  if (source.includes("__tablename__")) {
    entities = extractSqlalchemyEntities(relPath, root);
  }

  tree.delete();

  return {
    path: relPath,
    lang,
    loc: countLines(source),
    imports,
    symbols,
    ormHints: entities.map((e) => ({
      framework: "sqlalchemy",
      startLine: e.startLine,
      endLine: e.endLine,
    })),
    ...(entities.length > 0 ? { entities } : {}),
  };
}

// ---------------------------------------------------------------------------

function collectImports(node: Node, imports: ImportFact[]): void {
  switch (node.type) {
    case "future_import_statement":
      // `from __future__ import ...` is a language directive, not a dependency.
      return;
    case "import_statement": {
      // `import a.b, c as d` — one fact per dotted name; the module itself is
      // the dependency, so no symbol names.
      for (const child of node.namedChildren) {
        const dotted = child?.type === "aliased_import" ? child.childForFieldName("name") : child;
        if (dotted?.type === "dotted_name") {
          imports.push({ specifier: dotted.text, symbols: [], kind: "static", line: line(node) });
        }
      }
      return;
    }
    case "import_from_statement": {
      const moduleName = node.childForFieldName("module_name");
      if (!moduleName) return;
      const specifier = moduleName.text;
      const symbols: string[] = [];
      for (const child of node.namedChildren) {
        if (!child || child.equals(moduleName)) continue;
        if (child.type === "wildcard_import") symbols.push("*");
        else if (child.type === "dotted_name") symbols.push(child.text);
        else if (child.type === "aliased_import") {
          const name = child.childForFieldName("name");
          if (name) symbols.push(name.text);
        }
      }
      imports.push({ specifier, symbols, kind: "static", line: line(node) });
      return;
    }
    case "call": {
      const target = dynamicImportSpecifier(node);
      if (target !== null) {
        imports.push({ specifier: target, symbols: [], kind: "dynamic", line: line(node) });
      }
      break; // arguments may contain nested calls — keep walking
    }
    default:
      break;
  }
  for (const child of node.namedChildren) {
    if (child) collectImports(child, imports);
  }
}

/** `importlib.import_module("x")` / `__import__("x")` with a literal string. */
function dynamicImportSpecifier(call: Node): string | null {
  const fn = call.childForFieldName("function");
  if (!fn) return null;
  const isImportModule =
    fn.type === "attribute" &&
    fn.childForFieldName("object")?.text === "importlib" &&
    fn.childForFieldName("attribute")?.text === "import_module";
  const isDunderImport = fn.type === "identifier" && fn.text === "__import__";
  if (!isImportModule && !isDunderImport) return null;
  const firstArg = call.childForFieldName("arguments")?.namedChildren[0];
  if (firstArg?.type !== "string") return null;
  return stringText(firstArg);
}

// ---------------------------------------------------------------------------

function pushSymbol(symbols: SymbolFact[], def: Node, symbolKind: SymbolKind): void {
  const name = def.childForFieldName("name");
  if (!name) return;
  symbols.push({
    name: name.text,
    symbolKind,
    exported: false, // resolved after the walk (__all__ may appear anywhere)
    startLine: line(def),
    endLine: def.endPosition.row + 1,
  });
}

/** `a = 1`, `a: int = 1`, chained `a = b = 1`. Tuple targets are skipped in v1. */
function collectAssignmentTargets(assignment: Node, symbols: SymbolFact[]): void {
  const left = assignment.childForFieldName("left");
  if (left?.type === "identifier") {
    symbols.push({
      name: left.text,
      symbolKind: "const",
      exported: false,
      startLine: line(assignment),
      endLine: assignment.endPosition.row + 1,
    });
  }
  const right = assignment.childForFieldName("right");
  if (right?.type === "assignment") collectAssignmentTargets(right, symbols);
}

function tryParseDunderAll(assignment: Node): Set<string> | null {
  const left = assignment.childForFieldName("left");
  if (left?.type !== "identifier" || left.text !== "__all__") return null;
  const right = assignment.childForFieldName("right");
  if (right?.type !== "list" && right?.type !== "tuple") return null;
  const names = new Set<string>();
  for (const item of right.namedChildren) {
    if (item?.type === "string") names.add(stringText(item));
  }
  return names;
}

// ---------------------------------------------------------------------------

function stringText(stringNode: Node): string {
  const content = stringNode.namedChildren.find((c) => c?.type === "string_content");
  return content ? content.text : stringNode.text.replace(/^['"]|['"]$/g, "");
}

function line(node: Node): number {
  return node.startPosition.row + 1;
}

function countLines(source: string): number {
  if (source.length === 0) return 0;
  let lines = 1;
  for (let i = 0; i < source.length; i++) {
    if (source.charCodeAt(i) === 10) lines++;
  }
  return lines;
}
