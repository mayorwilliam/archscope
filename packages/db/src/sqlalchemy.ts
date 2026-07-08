import type { EntityField } from "@archmap/schema";
import type { Node } from "web-tree-sitter";
import { DEFAULT_DB_SCHEMA, type DeclaredEntity, type DeclaredRelation } from "./declared.js";

/**
 * SQLAlchemy extractor: declarative models → DeclaredEntity[], by pattern
 * matching an ALREADY-PARSED tree-sitter Python tree. The tree is injected by
 * the caller (core parses every .py once anyway) so this package needs no
 * WASM runtime of its own and never re-parses.
 *
 * Deterministic marker: any top-level class that assigns a literal
 * `__tablename__` is an entity — that covers classic declarative and the 2.0
 * Mapped[]/mapped_column() style, and never requires resolving the base class.
 * Explicitly out of scope in v1 (documented limits, not silent gaps):
 * Core `Table(...)` definitions, `ForeignKeyConstraint` in __table_args__,
 * and dynamic table names.
 */

export function extractSqlalchemyEntities(relPath: string, root: Node): DeclaredEntity[] {
  const entities: DeclaredEntity[] = [];
  for (const stmt of root.namedChildren) {
    if (!stmt) continue;
    const cls =
      stmt.type === "class_definition"
        ? stmt
        : stmt.type === "decorated_definition"
          ? childOfType(stmt, "class_definition")
          : null;
    if (!cls) continue;
    const entity = extractClass(relPath, cls);
    if (entity) entities.push(entity);
  }
  return entities;
}

// ---------------------------------------------------------------------------

function extractClass(relPath: string, cls: Node): DeclaredEntity | null {
  const name = cls.childForFieldName("name")?.text;
  const body = cls.childForFieldName("body");
  if (!name || !body) return null;

  let table: string | null = null;
  let dbSchema = DEFAULT_DB_SCHEMA;
  const fields: EntityField[] = [];
  const relations: DeclaredRelation[] = [];

  for (const stmt of body.namedChildren) {
    if (stmt?.type !== "expression_statement") continue;
    const assignment = childOfType(stmt, "assignment");
    if (!assignment) continue;
    const left = assignment.childForFieldName("left");
    if (left?.type !== "identifier") continue;

    if (left.text === "__tablename__") {
      const value = assignment.childForFieldName("right");
      if (value?.type === "string") table = stringText(value);
      continue;
    }
    if (left.text === "__table_args__") {
      const schema = tableArgsSchema(assignment.childForFieldName("right"));
      if (schema !== null) dbSchema = schema;
      continue;
    }
    const column = extractColumn(assignment, left.text);
    if (!column) continue;
    fields.push(column.field);
    if (column.fk) {
      relations.push({
        columns: [column.field.column ?? column.field.name],
        targetTable: column.fk.table,
        ...(column.fk.schema !== null ? { targetSchema: column.fk.schema } : {}),
        references: [column.fk.column],
      });
    }
  }

  if (table === null) return null; // not a declarative model

  return {
    name,
    filePath: relPath,
    orm: "sqlalchemy",
    table,
    schema: dbSchema,
    // __tablename__ is written in the source by definition.
    tableExplicit: true,
    fields,
    relations,
    startLine: cls.startPosition.row + 1,
    endLine: cls.endPosition.row + 1,
  };
}

interface ExtractedColumn {
  field: EntityField;
  fk: { schema: string | null; table: string; column: string } | null;
}

/**
 * One class-body assignment → column, or null when it isn't one.
 * Covers `x = Column(...)`, `x: Mapped[T] = mapped_column(...)` and the bare
 * annotation `x: Mapped[T]`. `relationship(...)` and arbitrary class attrs
 * are navigation/behavior, not columns.
 */
function extractColumn(assignment: Node, attrName: string): ExtractedColumn | null {
  const right = assignment.childForFieldName("right");
  const annotation = mappedInner(assignment.childForFieldName("type"));

  const call = right?.type === "call" ? right : null;
  const callee = call ? calleeName(call) : null;
  if (call && callee !== "Column" && callee !== "mapped_column") return null;
  if (!call && !annotation) return null; // plain class attribute
  if (annotation && isRelationshipAnnotation(annotation)) return null;

  let columnName: string | null = null;
  let typeText: string | null = null;
  let fk: ExtractedColumn["fk"] = null;
  let primaryKey = false;
  let nullableKwarg: boolean | null = null;

  for (const arg of call?.childForFieldName("arguments")?.namedChildren ?? []) {
    if (!arg) continue;
    if (arg.type === "string") {
      if (columnName === null) columnName = stringText(arg);
    } else if (arg.type === "keyword_argument") {
      const key = arg.childForFieldName("name")?.text;
      const value = arg.childForFieldName("value")?.text;
      if (key === "primary_key" && value === "True") primaryKey = true;
      else if (key === "nullable") nullableKwarg = value === "True";
    } else if (arg.type === "call" && calleeName(arg) === "ForeignKey") {
      fk = foreignKeyTarget(arg);
    } else if (arg.type === "comment") {
      // skip
    } else if (typeText === null) {
      typeText = arg.text; // Integer, String(255), sa.Text, ...
    }
  }

  const type = typeText ?? annotation?.typeText ?? "unknown";
  // SQLAlchemy semantics: explicit kwarg > primary key (NOT NULL) >
  // Mapped[Optional[...]] annotation > classic Column default (nullable).
  const nullable =
    nullableKwarg !== null
      ? nullableKwarg
      : primaryKey
        ? false
        : annotation
          ? annotation.optional
          : true;

  return {
    field: {
      name: attrName,
      type,
      ...(columnName !== null && columnName !== attrName ? { column: columnName } : {}),
      nullable,
      isPk: primaryKey,
      isFk: fk !== null,
    },
    fk,
  };
}

/** `ForeignKey("users.id")` / `ForeignKey("auth.users.id")` → parts. */
function foreignKeyTarget(call: Node): ExtractedColumn["fk"] {
  const first = call.childForFieldName("arguments")?.namedChildren[0];
  if (first?.type !== "string") return null;
  const parts = stringText(first).split(".");
  if (parts.length === 2)
    return { schema: null, table: parts[0] as string, column: parts[1] as string };
  if (parts.length === 3) {
    return { schema: parts[0] as string, table: parts[1] as string, column: parts[2] as string };
  }
  return null;
}

interface MappedAnnotation {
  /** Inner type text with Optional[...] unwrapped: Mapped[Optional[str]] → "str". */
  typeText: string;
  optional: boolean;
  raw: string;
}

/**
 * `Mapped[...]` annotation → inner type + nullability; null for anything else.
 * In type position tree-sitter-python produces generic_type/type_parameter
 * (NOT subscript): type > generic_type > [identifier, type_parameter > type].
 */
function mappedInner(typeNode: Node | null): MappedAnnotation | null {
  const generic = genericType(typeNode);
  if (!generic || genericHead(generic) !== "Mapped") return null;
  const inner = genericParam(generic);
  if (!inner) return null;
  const raw = inner.text;

  // Optional[X] → X · X | None → X
  const innerGeneric = genericType(inner);
  if (innerGeneric && genericHead(innerGeneric) === "Optional") {
    const wrapped = genericParam(innerGeneric);
    return { typeText: wrapped?.text ?? raw, optional: true, raw };
  }
  const binary = inner.type === "binary_operator" ? inner : childOfType(inner, "binary_operator");
  if (binary) {
    const left = binary.childForFieldName("left");
    const right = binary.childForFieldName("right");
    if (right?.text === "None") return { typeText: left?.text ?? raw, optional: true, raw };
  }
  return { typeText: raw, optional: false, raw };
}

/** A `type` wrapper (or the node itself) holding a generic_type. */
function genericType(node: Node | null): Node | null {
  if (!node) return null;
  if (node.type === "generic_type") return node;
  return childOfType(node, "generic_type");
}

/** generic_type → the identifier before the brackets ("Mapped", "Optional"). */
function genericHead(generic: Node): string | null {
  return generic.namedChildren[0]?.type === "identifier"
    ? (generic.namedChildren[0]?.text ?? null)
    : null;
}

/** generic_type → the single `type` inside its type_parameter. */
function genericParam(generic: Node): Node | null {
  const param = childOfType(generic, "type_parameter");
  return param ? childOfType(param, "type") : null;
}

/** Mapped[List["Post"]] / Mapped["User"] are relationship shapes, not columns. */
function isRelationshipAnnotation(annotation: MappedAnnotation): boolean {
  return /^(?:List\[|list\[|")/.test(annotation.raw);
}

/** `__table_args__ = {"schema": "x"}` or a tuple whose last element is that dict. */
function tableArgsSchema(value: Node | null): string | null {
  if (!value) return null;
  const dict =
    value.type === "dictionary"
      ? value
      : value.type === "tuple"
        ? ([...value.namedChildren].reverse().find((c) => c?.type === "dictionary") ?? null)
        : null;
  if (!dict) return null;
  for (const pair of dict.namedChildren) {
    if (pair?.type !== "pair") continue;
    const key = pair.childForFieldName("key");
    const val = pair.childForFieldName("value");
    if (key?.type === "string" && stringText(key) === "schema" && val?.type === "string") {
      return stringText(val);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------

/** `Column` / `sa.Column` / `sqlalchemy.orm.mapped_column` → last segment. */
function calleeName(call: Node): string | null {
  const fn = call.childForFieldName("function");
  if (!fn) return null;
  if (fn.type === "identifier") return fn.text;
  if (fn.type === "attribute") return fn.childForFieldName("attribute")?.text ?? null;
  return null;
}

function childOfType(node: Node, type: string): Node | null {
  return node.namedChildren.find((c) => c?.type === type) ?? null;
}

function stringText(stringNode: Node): string {
  const content = stringNode.namedChildren.find((c) => c?.type === "string_content");
  return content ? content.text : stringNode.text.replace(/^['"]|['"]$/g, "");
}
