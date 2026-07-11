import { type DeclaredEntity, extractDrizzleEntities, extractTypeormEntities } from "@archmap/db";
import type { Lang, SymbolKind } from "@archmap/schema";
import type { Node } from "web-tree-sitter";
import type { FileFacts, ImportFact, OrmHint, SymbolFact } from "./facts.js";
import { grammarForFile, parseSource } from "./parser.js";

/**
 * TS/JS fact extraction: one recursive AST walk collects imports (static,
 * re-export, dynamic, require) and top-level symbol declarations.
 *
 * Deliberately grammar-driven and deterministic — no heuristics, no LLM.
 * If tree-sitter can't see it (e.g. require(variable)), it is not a fact.
 */

export async function extractTsFacts(relPath: string, source: string): Promise<FileFacts> {
  const grammar = grammarForFile(relPath);
  if (!grammar || grammar === "python") {
    throw new Error(`extractTsFacts called for non-TS/JS file: ${relPath}`);
  }
  const { tree } = await parseSource(grammar, source);
  const lang: Lang = grammar === "javascript" ? "js" : "ts";

  const imports: ImportFact[] = [];
  const symbols: SymbolFact[] = [];
  const exportedNames = new Set<string>();

  const root = tree.rootNode;

  // Pass 1: top-level statements (imports, exports, declarations).
  for (const stmt of root.namedChildren) {
    if (!stmt) continue;
    switch (stmt.type) {
      case "import_statement":
        collectImportStatement(stmt, imports);
        break;
      case "export_statement":
        collectExportStatement(stmt, imports, symbols, exportedNames);
        break;
      default:
        collectDeclaration(stmt, symbols, false);
        break;
    }
  }

  // Pass 2: dynamic import() / require() can appear anywhere in the tree.
  collectDynamicImports(root, imports);

  // `export { a, b }` clauses reference declarations found elsewhere.
  for (const sym of symbols) {
    if (exportedNames.has(sym.name)) sym.exported = true;
  }

  // The import IS the deterministic ORM marker — a file can't declare TypeORM
  // or Drizzle tables without importing from the package.
  const entities: DeclaredEntity[] = [];
  if (imports.some((i) => i.specifier === "typeorm")) {
    entities.push(...extractTypeormEntities(relPath, root));
  }
  if (imports.some((i) => i.specifier.startsWith("drizzle-orm"))) {
    entities.push(...extractDrizzleEntities(relPath, root));
  }

  tree.delete();

  return {
    path: relPath,
    lang,
    loc: countLines(source),
    imports,
    symbols,
    ormHints: entities.map(
      (e): OrmHint => ({ framework: e.orm, startLine: e.startLine, endLine: e.endLine }),
    ),
    ...(entities.length > 0 ? { entities } : {}),
  };
}

// ---------------------------------------------------------------------------

function collectImportStatement(node: Node, imports: ImportFact[]): void {
  const specifier = sourceString(node);
  if (specifier === null) return;
  const symbols: string[] = [];
  const clause = node.namedChildren.find((c) => c?.type === "import_clause");
  if (clause) {
    for (const child of clause.namedChildren) {
      if (!child) continue;
      if (child.type === "identifier") symbols.push("default");
      else if (child.type === "namespace_import") symbols.push("*");
      else if (child.type === "named_imports") {
        for (const spec of child.namedChildren) {
          if (spec?.type !== "import_specifier") continue;
          const name = spec.childForFieldName("name");
          if (name) symbols.push(name.text);
        }
      }
    }
  }
  imports.push({ specifier, symbols, kind: "static", line: line(node) });
}

function collectExportStatement(
  node: Node,
  imports: ImportFact[],
  symbols: SymbolFact[],
  exportedNames: Set<string>,
): void {
  const specifier = sourceString(node);
  if (specifier !== null) {
    // Re-export: `export { a } from "x"` / `export * from "x"`.
    const names: string[] = [];
    for (const child of node.namedChildren) {
      if (!child) continue;
      if (child.type === "export_clause") {
        for (const spec of child.namedChildren) {
          if (spec?.type !== "export_specifier") continue;
          const name = spec.childForFieldName("name");
          if (name) names.push(name.text);
        }
      } else if (child.type === "namespace_export") {
        names.push("*");
      }
    }
    if (names.length === 0) names.push("*");
    imports.push({ specifier, symbols: names, kind: "reexport", line: line(node) });
    return;
  }

  const declaration = node.childForFieldName("declaration");
  if (declaration) {
    collectDeclaration(declaration, symbols, true);
    return;
  }

  // `export { a, b }` — names declared elsewhere in this file.
  for (const child of node.namedChildren) {
    if (child?.type !== "export_clause") continue;
    for (const spec of child.namedChildren) {
      if (spec?.type !== "export_specifier") continue;
      const name = spec.childForFieldName("name");
      if (name) exportedNames.add(name.text);
    }
  }
}

const DECLARATION_KINDS: Record<string, SymbolKind> = {
  function_declaration: "function",
  generator_function_declaration: "function",
  class_declaration: "class",
  abstract_class_declaration: "class",
  type_alias_declaration: "type",
  interface_declaration: "interface",
  enum_declaration: "enum",
};

function collectDeclaration(node: Node, symbols: SymbolFact[], exported: boolean): void {
  const kind = DECLARATION_KINDS[node.type];
  if (kind) {
    const name = node.childForFieldName("name");
    if (name) {
      symbols.push({
        name: name.text,
        symbolKind: kind,
        exported,
        startLine: line(node),
        endLine: node.endPosition.row + 1,
      });
    }
    return;
  }
  if (node.type === "lexical_declaration" || node.type === "variable_declaration") {
    for (const decl of node.namedChildren) {
      if (decl?.type !== "variable_declarator") continue;
      const name = decl.childForFieldName("name");
      // Destructuring patterns are skipped in v1: only identifier declarators.
      if (name?.type === "identifier") {
        symbols.push({
          name: name.text,
          symbolKind: "const",
          exported,
          startLine: line(node),
          endLine: node.endPosition.row + 1,
        });
      }
    }
  }
}

function collectDynamicImports(node: Node, imports: ImportFact[]): void {
  if (node.type === "call_expression") {
    const fn = node.childForFieldName("function");
    const args = node.childForFieldName("arguments");
    const firstArg = args?.namedChildren[0];
    if (firstArg?.type === "string") {
      const specifier = stringText(firstArg);
      if (fn?.type === "import") {
        imports.push({ specifier, symbols: [], kind: "dynamic", line: line(node) });
      } else if (fn?.type === "identifier" && fn.text === "require") {
        imports.push({ specifier, symbols: [], kind: "require", line: line(node) });
      }
    }
  }
  for (const child of node.namedChildren) {
    if (child) collectDynamicImports(child, imports);
  }
}

// ---------------------------------------------------------------------------

function sourceString(node: Node): string | null {
  const source = node.childForFieldName("source");
  if (source?.type !== "string") return null;
  return stringText(source);
}

function stringText(stringNode: Node): string {
  const fragment = stringNode.namedChildren.find((c) => c?.type === "string_fragment");
  return fragment ? fragment.text : stringNode.text.slice(1, -1);
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
