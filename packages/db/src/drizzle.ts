import type { EntityField } from "@archmap/schema";
import type { Node } from "web-tree-sitter";
import { DEFAULT_DB_SCHEMA, type DeclaredEntity, type DeclaredRelation } from "./declared.js";

/**
 * Drizzle extractor: pgTable/mysqlTable/sqliteTable declarations →
 * DeclaredEntity[], by pattern matching an ALREADY-PARSED tree-sitter TS tree
 * injected by core — same contract as the other static extractors.
 *
 * Deterministic marker: a variable initialized with a call to one of the
 * table builders (or `<schemaVar>.table(...)` where schemaVar came from
 * pgSchema/mysqlSchema in the same file). The table name is always written
 * in the source → every Drizzle maps_to is `certain`. The entity name is the
 * variable name — that is what `.references(() => users.id)` points at, so
 * FK targets resolve by entity across files.
 * Explicitly out of scope in v1 (documented limits, not silent gaps):
 * composite PKs in the third config arg, `relations()` navigation helpers
 * (no FK column of their own) and spread/helper column objects.
 */

const TABLE_BUILDERS = new Set(["pgTable", "mysqlTable", "sqliteTable"]);
const SCHEMA_BUILDERS = new Set(["pgSchema", "mysqlSchema"]);

export function extractDrizzleEntities(relPath: string, root: Node): DeclaredEntity[] {
  const entities: DeclaredEntity[] = [];
  const schemaVars = new Map<string, string>(); // variable name → DB schema name

  for (const stmt of root.namedChildren) {
    if (!stmt) continue;
    const declaration =
      stmt.type === "lexical_declaration" || stmt.type === "variable_declaration"
        ? stmt
        : stmt.type === "export_statement"
          ? (childOfType(stmt, "lexical_declaration") ?? childOfType(stmt, "variable_declaration"))
          : null;
    for (const declarator of declaration?.namedChildren ?? []) {
      if (declarator?.type !== "variable_declarator") continue;
      const name = childOfType(declarator, "identifier")?.text;
      const init = childOfType(declarator, "call_expression");
      if (!name || !init) continue;

      const schemaName = schemaBuilderArg(init);
      if (schemaName !== null) {
        schemaVars.set(name, schemaName);
        continue;
      }
      const entity = extractTable(relPath, name, init, declarator, schemaVars);
      if (entity) entities.push(entity);
    }
  }
  return entities;
}

// ---------------------------------------------------------------------------

/** `pgSchema("auth")` → "auth"; null when the call is not a schema builder. */
function schemaBuilderArg(call: Node): string | null {
  const callee = childOfType(call, "identifier");
  if (!callee || !SCHEMA_BUILDERS.has(callee.text)) return null;
  const first = childOfType(call, "arguments")?.namedChildren[0];
  return first?.type === "string" ? stringText(first) : null;
}

function extractTable(
  relPath: string,
  varName: string,
  call: Node,
  declarator: Node,
  schemaVars: Map<string, string>,
): DeclaredEntity | null {
  let dbSchema = DEFAULT_DB_SCHEMA;
  const callee = childOfType(call, "identifier");
  const member = childOfType(call, "member_expression");
  if (callee && TABLE_BUILDERS.has(callee.text)) {
    // plain pgTable(...)
  } else if (member) {
    // auth.table(...) — only when `auth` was a schema builder in this file.
    const object = childOfType(member, "identifier");
    const property = childOfType(member, "property_identifier");
    const known = object ? schemaVars.get(object.text) : undefined;
    if (property?.text !== "table" || known === undefined) return null;
    dbSchema = known;
  } else {
    return null;
  }

  const args = childOfType(call, "arguments");
  const tableName = args?.namedChildren[0];
  const columnsObject = args?.namedChildren.find((c) => c?.type === "object");
  if (tableName?.type !== "string" || !columnsObject) return null;

  const fields: EntityField[] = [];
  const relations: DeclaredRelation[] = [];
  for (const pair of columnsObject.namedChildren) {
    if (pair?.type !== "pair") continue;
    const key = pair.namedChildren[0]?.text;
    const value = pair.namedChildren[1];
    if (!key || value?.type !== "call_expression") continue;
    const column = extractColumn(key, value);
    if (!column) continue;
    fields.push(column.field);
    if (column.fk) {
      relations.push({
        columns: [column.field.column ?? column.field.name],
        targetEntity: column.fk.entity,
        references: [column.fk.field],
      });
    }
  }

  return {
    name: varName,
    filePath: relPath,
    orm: "drizzle",
    table: stringText(tableName),
    schema: dbSchema,
    tableExplicit: true, // the builder's first argument IS the table name
    fields,
    relations,
    startLine: declarator.startPosition.row + 1,
    endLine: declarator.endPosition.row + 1,
  };
}

// ---------------------------------------------------------------------------

interface ExtractedColumn {
  field: EntityField;
  fk: { entity: string; field: string } | null;
}

/**
 * One column chain — `varchar("email", {...}).notNull().references(() => x.y)`
 * — unwound from the outside in. The innermost call names the SQL type; each
 * chained method refines nullability/PK/FK.
 */
function extractColumn(key: string, outermost: Node): ExtractedColumn | null {
  let isPk = false;
  let notNull = false;
  let fk: ExtractedColumn["fk"] = null;

  let call = outermost;
  for (;;) {
    const member = childOfType(call, "member_expression");
    if (!member) break; // reached the innermost type call
    const method = childOfType(member, "property_identifier")?.text;
    if (method === "primaryKey") {
      isPk = true;
      notNull = true;
    } else if (method === "notNull") {
      notNull = true;
    } else if (method === "references") {
      fk = referencesTarget(call) ?? fk;
    }
    // .unique(), .default(), .$type() … don't change the declared shape.
    const inner = childOfType(member, "call_expression");
    if (!inner) return null; // chain on something that isn't a column builder
    call = inner;
  }

  const type = childOfType(call, "identifier")?.text;
  if (!type) return null;
  const firstArg = childOfType(call, "arguments")?.namedChildren[0];
  // `serial("user_id")` names the column; `serial()` inherits the object key.
  const columnName = firstArg?.type === "string" ? stringText(firstArg) : key;

  return {
    field: {
      name: key,
      type,
      ...(columnName !== key ? { column: columnName } : {}),
      nullable: !notNull,
      isPk,
      isFk: fk !== null,
    },
    fk,
  };
}

/** `.references(() => teams.id)` → { entity: "teams", field: "id" }. */
function referencesTarget(call: Node): ExtractedColumn["fk"] {
  const arrow = childOfType(call, "arguments")?.namedChildren.find(
    (c) => c?.type === "arrow_function",
  );
  const body = arrow?.namedChildren.find((c) => c && c.type !== "formal_parameters");
  if (body?.type !== "member_expression") return null;
  const entity = childOfType(body, "identifier");
  const field = childOfType(body, "property_identifier");
  return entity && field ? { entity: entity.text, field: field.text } : null;
}

// ---------------------------------------------------------------------------

function childOfType(node: Node, type: string): Node | null {
  return node.namedChildren.find((c) => c?.type === type) ?? null;
}

function stringText(stringNode: Node): string {
  const fragment = stringNode.namedChildren.find((c) => c?.type === "string_fragment");
  return fragment ? fragment.text : stringNode.text.replace(/^['"`]|['"`]$/g, "");
}
