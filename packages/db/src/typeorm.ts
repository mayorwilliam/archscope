import type { EntityField } from "@archmap/schema";
import type { Node } from "web-tree-sitter";
import { DEFAULT_DB_SCHEMA, type DeclaredEntity, type DeclaredRelation } from "./declared.js";

/**
 * TypeORM extractor: decorated entity classes → DeclaredEntity[], by pattern
 * matching an ALREADY-PARSED tree-sitter TS/TSX tree injected by core — same
 * contract as the SQLAlchemy extractor (no WASM here, never re-parses).
 *
 * Deterministic marker: a class decorated with `@Entity(...)`. Table names
 * follow TypeORM's DefaultNamingStrategy (snake_case of the class name)
 * unless written in the source → tableExplicit drives maps_to confidence.
 * Explicitly out of scope in v1 (documented limits, not silent gaps):
 * custom naming strategies, embedded entities, single-table inheritance,
 * @ManyToMany junction tables and EntitySchema definitions.
 */

export function extractTypeormEntities(relPath: string, root: Node): DeclaredEntity[] {
  const entities: DeclaredEntity[] = [];
  for (const stmt of root.namedChildren) {
    if (!stmt) continue;
    // Decorators written above `export` attach to the export_statement, not
    // to the class_declaration inside it — collect from both levels.
    const cls =
      stmt.type === "class_declaration"
        ? stmt
        : stmt.type === "export_statement"
          ? (childOfType(stmt, "class_declaration") ?? null)
          : null;
    if (!cls) continue;
    const decorators = [...decoratorsOf(stmt), ...(stmt === cls ? [] : decoratorsOf(cls))];
    const entityDecorator = decorators.find((d) => d.name === "Entity");
    if (!entityDecorator) continue;
    const entity = extractClass(relPath, cls, entityDecorator);
    if (entity) entities.push(entity);
  }
  return entities;
}

// ---------------------------------------------------------------------------

interface Decorator {
  name: string;
  /** Positional string args + the first object-literal arg, when present. */
  strings: string[];
  options: Node | null;
  node: Node;
}

function extractClass(
  relPath: string,
  cls: Node,
  entityDecorator: Decorator,
): DeclaredEntity | null {
  const name = childOfType(cls, "type_identifier")?.text;
  const body = childOfType(cls, "class_body");
  if (!name || !body) return null;

  const explicitTable = entityDecorator.strings[0] ?? optionString(entityDecorator.options, "name");
  const schema = optionString(entityDecorator.options, "schema") ?? DEFAULT_DB_SCHEMA;

  const fields: EntityField[] = [];
  const relations: DeclaredRelation[] = [];

  for (const member of body.namedChildren) {
    if (member?.type !== "public_field_definition") continue;
    const propName = childOfType(member, "property_identifier")?.text;
    if (!propName) continue;
    const decorators = decoratorsOf(member);

    const column = columnFromDecorators(member, propName, decorators);
    if (column) {
      fields.push(column);
      continue;
    }
    const relation = relationFromDecorators(propName, decorators);
    if (relation) {
      fields.push(relation.field);
      relations.push(relation.relation);
    }
  }

  return {
    name,
    filePath: relPath,
    orm: "typeorm",
    table: explicitTable ?? snakeCase(name),
    schema,
    tableExplicit: explicitTable !== undefined,
    fields,
    relations,
    startLine: cls.startPosition.row + 1,
    endLine: cls.endPosition.row + 1,
  };
}

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/** Decorator name → fixed SQL type, for the timestamp/version housekeeping columns. */
const SPECIAL_COLUMNS: Record<string, { type: string; nullable: boolean }> = {
  CreateDateColumn: { type: "timestamp", nullable: false },
  UpdateDateColumn: { type: "timestamp", nullable: false },
  DeleteDateColumn: { type: "timestamp", nullable: true },
  VersionColumn: { type: "int", nullable: false },
};

/** TypeORM's default TS type → column type mapping (postgres spellings). */
const TS_TYPE_DEFAULTS: Record<string, string> = {
  number: "int",
  string: "varchar",
  boolean: "boolean",
  Date: "timestamp",
};

function columnFromDecorators(
  member: Node,
  propName: string,
  decorators: Decorator[],
): EntityField | null {
  const column = decorators.find((d) =>
    ["Column", "PrimaryColumn", "PrimaryGeneratedColumn"].includes(d.name),
  );
  const special = decorators.find((d) => SPECIAL_COLUMNS[d.name]);

  if (!column && !special) return null;
  if (special && !column) {
    const { type, nullable } = SPECIAL_COLUMNS[special.name] as { type: string; nullable: boolean };
    const columnName = optionString(special.options, "name");
    return {
      name: propName,
      type,
      ...(columnName !== undefined && columnName !== propName ? { column: columnName } : {}),
      nullable,
      isPk: false,
      isFk: false,
    };
  }

  const dec = column as Decorator;
  const isPk = dec.name !== "Column";
  // @Column("varchar") / @PrimaryGeneratedColumn("uuid") — first string is the type.
  const declaredType = dec.strings[0] ?? optionString(dec.options, "type");
  const annotated = annotationType(member);
  const type =
    declaredType ??
    (dec.name === "PrimaryGeneratedColumn"
      ? "int" // strategy "increment" → SERIAL/int
      : (TS_TYPE_DEFAULTS[annotated ?? ""] ?? "unknown"));

  const columnName = optionString(dec.options, "name");
  const nullable = isPk ? false : optionBoolean(dec.options, "nullable") === true;

  return {
    name: propName,
    type,
    ...(columnName !== undefined && columnName !== propName ? { column: columnName } : {}),
    nullable,
    isPk,
    isFk: false,
  };
}

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

/**
 * FK-owning relations only: @ManyToOne always owns the FK column; @OneToOne
 * owns it iff @JoinColumn is present. OneToMany/ManyToMany are navigation.
 * TypeORM creates the join column implicitly, so a field is synthesized for
 * it (type "unknown" — the target's PK type is another file's fact; drift
 * treats "unknown" as incomparable, never a fabricated mismatch).
 */
function relationFromDecorators(
  propName: string,
  decorators: Decorator[],
): { field: EntityField; relation: DeclaredRelation } | null {
  const joinColumn = decorators.find((d) => d.name === "JoinColumn") ?? null;
  const relation =
    decorators.find((d) => d.name === "ManyToOne") ??
    (joinColumn ? decorators.find((d) => d.name === "OneToOne") : undefined);
  if (!relation) return null;

  const target = relationTarget(relation);
  if (!target) return null;

  const referencedColumn =
    optionString(joinColumn?.options ?? null, "referencedColumnName") ?? "id";
  // DefaultNamingStrategy.joinColumnName: camelCase(`${prop}_${referenced}`).
  const columnName =
    optionString(joinColumn?.options ?? null, "name") ??
    camelCase(`${propName}_${referencedColumn}`);
  // Relations are nullable by default (unlike columns).
  const nullable = optionBoolean(relation.options, "nullable") !== false;

  return {
    field: {
      name: propName,
      type: "unknown",
      ...(columnName !== propName ? { column: columnName } : {}),
      nullable,
      isPk: false,
      isFk: true,
    },
    relation: {
      columns: [columnName],
      targetEntity: target,
      references: [referencedColumn],
    },
  };
}

/** `@ManyToOne(() => Team, ...)` / `@ManyToOne("Team", ...)` → "Team". */
function relationTarget(decorator: Decorator): string | null {
  if (decorator.strings[0]) return decorator.strings[0];
  const args = decorator.node.descendantsOfType("arrow_function")[0];
  const body = args?.namedChildren.find((c) => c && c.type !== "formal_parameters");
  return body?.type === "identifier" ? body.text : null;
}

// ---------------------------------------------------------------------------
// Decorator plumbing
// ---------------------------------------------------------------------------

function decoratorsOf(node: Node): Decorator[] {
  const out: Decorator[] = [];
  for (const child of node.namedChildren) {
    if (child?.type !== "decorator") continue;
    const call = childOfType(child, "call_expression");
    const callee = call ? childOfType(call, "identifier") : childOfType(child, "identifier");
    if (!callee) continue;
    const strings: string[] = [];
    let options: Node | null = null;
    for (const arg of (call ? childOfType(call, "arguments") : null)?.namedChildren ?? []) {
      if (!arg) continue;
      if (arg.type === "string") strings.push(stringText(arg));
      else if (arg.type === "object" && options === null) options = arg;
    }
    out.push({ name: callee.text, strings, options, node: child });
  }
  return out;
}

/** `{ name: "users", ... }` → value of a string property, when literal. */
function optionString(options: Node | null, key: string): string | undefined {
  const value = optionValue(options, key);
  return value?.type === "string" ? stringText(value) : undefined;
}

function optionBoolean(options: Node | null, key: string): boolean | undefined {
  const value = optionValue(options, key);
  if (value?.type === "true") return true;
  if (value?.type === "false") return false;
  return undefined;
}

function optionValue(options: Node | null, key: string): Node | null {
  for (const pair of options?.namedChildren ?? []) {
    if (pair?.type !== "pair") continue;
    if (pair.namedChildren[0]?.text === key) return pair.namedChildren[1] ?? null;
  }
  return null;
}

/** Field's TS annotation when it is a simple named type: `id!: number` → "number". */
function annotationType(member: Node): string | null {
  const annotation = childOfType(member, "type_annotation");
  const inner = annotation?.namedChildren[0];
  if (!inner) return null;
  if (inner.type === "predefined_type" || inner.type === "type_identifier") return inner.text;
  return null;
}

// ---------------------------------------------------------------------------

/** TypeORM StringUtils.snakeCase, verbatim: "UserProfile" → "user_profile". */
function snakeCase(str: string): string {
  return str.replace(/(?:([a-z])([A-Z]))|(?:((?!^)[A-Z])([a-z]))/g, "$1_$3$2$4").toLowerCase();
}

/** TypeORM StringUtils.camelCase over snake input: "team_id" → "teamId". */
function camelCase(str: string): string {
  return str.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());
}

function childOfType(node: Node, type: string): Node | null {
  return node.namedChildren.find((c) => c?.type === type) ?? null;
}

function stringText(stringNode: Node): string {
  const fragment = stringNode.namedChildren.find((c) => c?.type === "string_fragment");
  return fragment ? fragment.text : stringNode.text.replace(/^['"`]|['"`]$/g, "");
}
