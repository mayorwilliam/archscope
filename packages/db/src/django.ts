import type { EntityField } from "@archscope/schema";
import type { Node } from "web-tree-sitter";
import { DEFAULT_DB_SCHEMA, type DeclaredEntity, type DeclaredRelation } from "./declared.js";

/**
 * Django extractor: models.Model subclasses → DeclaredEntity[], by pattern
 * matching an ALREADY-PARSED tree-sitter Python tree injected by core — same
 * contract as the SQLAlchemy extractor.
 *
 * Deterministic marker: a top-level class whose bases textually include
 * `models.Model` or `Model` (never resolves the base through imports —
 * custom abstract bases are out of scope, documented). Abstract models
 * (`Meta.abstract = True`) are skipped. Table names follow Django's
 * `<app>_<model>` convention (app label = the package containing models.py)
 * unless `Meta.db_table` is written → tableExplicit drives confidence.
 *
 * FK columns and the implicit `id` PK are declared with type "unknown" where
 * Django decides the SQL type at migration time (AutoField vs BigAutoField
 * depends on settings.DEFAULT_AUTO_FIELD) — drift treats "unknown" as
 * incomparable rather than fabricating mismatches.
 */

export function extractDjangoEntities(relPath: string, root: Node): DeclaredEntity[] {
  const entities: DeclaredEntity[] = [];
  const appLabel = appLabelFromPath(relPath);
  for (const stmt of root.namedChildren) {
    if (!stmt) continue;
    const cls =
      stmt.type === "class_definition"
        ? stmt
        : stmt.type === "decorated_definition"
          ? childOfType(stmt, "class_definition")
          : null;
    if (!cls || !isModelSubclass(cls)) continue;
    const entity = extractModel(relPath, appLabel, cls);
    if (entity) entities.push(entity);
  }
  return entities;
}

// ---------------------------------------------------------------------------

/** `models.py` sits inside its app package: `shop/models.py` → "shop". */
function appLabelFromPath(relPath: string): string {
  const parts = relPath.split("/");
  const modelsIndex = parts.findIndex((p) => p === "models.py" || p === "models");
  if (modelsIndex > 0) return parts[modelsIndex - 1] as string;
  return parts.length > 1 ? (parts[parts.length - 2] as string) : "app";
}

function isModelSubclass(cls: Node): boolean {
  const bases = cls.childForFieldName("superclasses");
  for (const base of bases?.namedChildren ?? []) {
    if (!base) continue;
    if (base.type === "identifier" && base.text === "Model") return true;
    if (base.type === "attribute" && base.text === "models.Model") return true;
  }
  return false;
}

function extractModel(relPath: string, appLabel: string, cls: Node): DeclaredEntity | null {
  const name = cls.childForFieldName("name")?.text;
  const body = cls.childForFieldName("body");
  if (!name || !body) return null;

  const meta = readMeta(body);
  if (meta.abstract) return null;

  const fields: EntityField[] = [];
  const relations: DeclaredRelation[] = [];

  for (const stmt of body.namedChildren) {
    if (stmt?.type !== "expression_statement") continue;
    const assignment = childOfType(stmt, "assignment");
    const left = assignment?.childForFieldName("left");
    const right = assignment?.childForFieldName("right");
    if (left?.type !== "identifier" || right?.type !== "call") continue;
    const fieldType = calleeName(right);
    if (!fieldType) continue;

    if (fieldType === "ForeignKey" || fieldType === "OneToOneField") {
      const fk = extractForeignKey(left.text, right);
      if (fk) {
        fields.push(fk.field);
        relations.push(fk.relation);
      }
    } else if (fieldType === "ManyToManyField") {
      // junction table, no column on this model — navigation only
    } else if (fieldType.endsWith("Field")) {
      fields.push(extractField(left.text, fieldType, right));
    }
  }

  // Django adds an implicit auto PK unless some field declares primary_key.
  if (!fields.some((f) => f.isPk)) {
    fields.unshift({ name: "id", type: "unknown", nullable: false, isPk: true, isFk: false });
  }

  return {
    name,
    filePath: relPath,
    orm: "django",
    table: meta.dbTable ?? `${appLabel}_${name.toLowerCase()}`,
    schema: DEFAULT_DB_SCHEMA,
    tableExplicit: meta.dbTable !== undefined,
    fields,
    relations,
    startLine: cls.startPosition.row + 1,
    endLine: cls.endPosition.row + 1,
  };
}

// ---------------------------------------------------------------------------

function extractField(name: string, fieldType: string, call: Node): EntityField {
  const kwargs = readKwargs(call);
  const column = kwargs.strings.get("db_column");
  return {
    name,
    type: fieldType,
    ...(column !== undefined && column !== name ? { column } : {}),
    nullable: kwargs.bools.get("null") === true,
    isPk: kwargs.bools.get("primary_key") === true,
    isFk: false,
  };
}

/**
 * `team = models.ForeignKey(Team, ...)` → column `team_id` referencing the
 * target's `id` (or `to_field`). The target arrives as an identifier, an
 * attribute, or an "app.Model" string — the class name is the last segment.
 */
function extractForeignKey(
  name: string,
  call: Node,
): { field: EntityField; relation: DeclaredRelation } | null {
  const first = call.childForFieldName("arguments")?.namedChildren[0];
  let target: string | null = null;
  if (first?.type === "identifier") target = first.text;
  else if (first?.type === "attribute") target = first.childForFieldName("attribute")?.text ?? null;
  else if (first?.type === "string") target = stringText(first).split(".").pop() ?? null;
  if (!target || target === "self") return null; // self-FKs skipped in v1

  const kwargs = readKwargs(call);
  const column = kwargs.strings.get("db_column") ?? `${name}_id`;
  const reference = kwargs.strings.get("to_field") ?? "id";

  return {
    field: {
      name,
      type: "unknown", // matches the target PK's type, decided at migration time
      ...(column !== name ? { column } : {}),
      nullable: kwargs.bools.get("null") === true,
      isPk: false,
      isFk: true,
    },
    relation: {
      columns: [column],
      targetEntity: target,
      references: [reference],
    },
  };
}

// ---------------------------------------------------------------------------

interface ModelMeta {
  abstract: boolean;
  dbTable?: string;
}

/** The nested `class Meta:` block — only literal assignments are read. */
function readMeta(body: Node): ModelMeta {
  const meta: ModelMeta = { abstract: false };
  for (const stmt of body.namedChildren) {
    if (stmt?.type !== "class_definition" || stmt.childForFieldName("name")?.text !== "Meta") {
      continue;
    }
    for (const metaStmt of stmt.childForFieldName("body")?.namedChildren ?? []) {
      if (metaStmt?.type !== "expression_statement") continue;
      const assignment = childOfType(metaStmt, "assignment");
      const left = assignment?.childForFieldName("left");
      const right = assignment?.childForFieldName("right");
      if (left?.type !== "identifier" || !right) continue;
      if (left.text === "abstract" && right.text === "True") meta.abstract = true;
      if (left.text === "db_table" && right.type === "string") meta.dbTable = stringText(right);
    }
  }
  return meta;
}

interface Kwargs {
  strings: Map<string, string>;
  bools: Map<string, boolean>;
}

function readKwargs(call: Node): Kwargs {
  const kwargs: Kwargs = { strings: new Map(), bools: new Map() };
  for (const arg of call.childForFieldName("arguments")?.namedChildren ?? []) {
    if (arg?.type !== "keyword_argument") continue;
    const key = arg.childForFieldName("name")?.text;
    const value = arg.childForFieldName("value");
    if (!key || !value) continue;
    if (value.type === "string") kwargs.strings.set(key, stringText(value));
    else if (value.type === "true") kwargs.bools.set(key, true);
    else if (value.type === "false") kwargs.bools.set(key, false);
  }
  return kwargs;
}

// ---------------------------------------------------------------------------

/** `models.CharField` / `CharField` → last segment. */
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
