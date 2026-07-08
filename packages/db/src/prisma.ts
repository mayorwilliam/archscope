import type { EntityField } from "@archmap/schema";
import {
  type Attribute,
  type AttributeArgument,
  type Field,
  getSchema,
  type KeyValue,
  type Model,
  PrismaParser,
  type RelationArray,
  type Schema,
  type Value,
  VisitorClassFactory,
} from "@mrleebo/prisma-ast";
import { DEFAULT_DB_SCHEMA, type DeclaredEntity, type DeclaredRelation } from "./declared.js";

/**
 * Prisma extractor: schema.prisma → DeclaredEntity[], via @mrleebo/prisma-ast
 * (a real parser, not regexes — comments and multiline attributes just work).
 *
 * Mapping rules:
 * - table name: @@map("x") wins (explicit → certain); otherwise the model
 *   name verbatim (Prisma's default) → inferred.
 * - columns: scalar and enum fields only. Relation fields (whose type is
 *   another model) are navigation properties, not columns — their
 *   @relation(fields: [...], references: [...]) becomes a DeclaredRelation
 *   and marks the underlying scalar fields as FKs.
 * - PK: @id on the field or the model's @@id([...]).
 */

// The default parser has nodeLocationTracking "none"; entity spans need lines.
const parser = new PrismaParser({ nodeLocationTracking: "full" });
const visitor = new (VisitorClassFactory(parser))();

export function extractPrismaEntities(relPath: string, source: string): DeclaredEntity[] {
  let schema: Schema;
  try {
    schema = getSchema(source, { parser, visitor });
  } catch {
    return []; // an unparseable schema contributes no facts, same as a syntax-error .ts file
  }

  const modelNames = new Set<string>();
  for (const block of schema.list) {
    if (block.type === "model") modelNames.add(block.name);
  }

  const entities: DeclaredEntity[] = [];
  for (const block of schema.list) {
    if (block.type !== "model") continue;
    entities.push(extractModel(relPath, block, modelNames, source));
  }
  return entities;
}

// ---------------------------------------------------------------------------

function extractModel(
  relPath: string,
  model: Model,
  modelNames: Set<string>,
  source: string,
): DeclaredEntity {
  let table = model.name;
  let tableExplicit = false;
  let dbSchema = DEFAULT_DB_SCHEMA;
  const compositePk = new Set<string>();

  const fields: EntityField[] = [];
  const fieldsByName = new Map<string, EntityField>();
  /** Relations carry field names until all columns are known; mapped at the end. */
  const rawRelations: Array<{ fieldNames: string[]; target: string; references: string[] }> = [];

  for (const prop of model.properties) {
    if (prop.type === "attribute") {
      // Model-level: @@map("users"), @@schema("auth"), @@id([a, b]).
      const arg = firstArgValue(prop.args);
      if (prop.name === "map" && typeof arg === "string") {
        table = unquote(arg);
        tableExplicit = true;
      } else if (prop.name === "schema" && typeof arg === "string") {
        dbSchema = unquote(arg);
      } else if (prop.name === "id") {
        for (const name of relationArrayNames(arg)) compositePk.add(name);
      }
      continue;
    }
    if (prop.type !== "field") continue;

    const typeName = typeof prop.fieldType === "string" ? prop.fieldType : prop.fieldType.name;
    if (modelNames.has(typeName)) {
      const relation = relationFromField(prop, typeName);
      if (relation) rawRelations.push(relation);
      continue; // navigation property, not a column
    }

    const column = fieldAttrString(prop.attributes, "map");
    const field: EntityField = {
      name: prop.name,
      type: typeName,
      ...(column !== null ? { column } : {}),
      nullable: prop.optional === true,
      isPk: hasFieldAttr(prop.attributes, "id"),
      isFk: false, // set below once relations are resolved
    };
    fields.push(field);
    fieldsByName.set(field.name, field);
  }

  for (const name of compositePk) {
    const field = fieldsByName.get(name);
    if (field) field.isPk = true;
  }

  const relations: DeclaredRelation[] = [];
  for (const raw of rawRelations) {
    const columns: string[] = [];
    for (const fieldName of raw.fieldNames) {
      const field = fieldsByName.get(fieldName);
      if (!field) continue;
      field.isFk = true;
      columns.push(field.column ?? field.name);
    }
    if (columns.length === 0) continue; // the "many" side of a relation has no FK here
    relations.push({ columns, targetEntity: raw.target, references: raw.references });
  }

  return {
    name: model.name,
    filePath: relPath,
    orm: "prisma",
    table,
    schema: dbSchema,
    tableExplicit,
    fields,
    relations,
    startLine: model.location?.startLine ?? 1,
    // The CST location covers the header token only; the block's real end is
    // its closing brace (models never nest, so brace counting is exact).
    endLine: blockEndLine(source, model.location?.startLine ?? 1),
  };
}

function blockEndLine(source: string, startLine: number): number {
  const lines = source.split("\n");
  let depth = 0;
  let opened = false;
  for (let i = startLine - 1; i < lines.length; i++) {
    for (const ch of lines[i] ?? "") {
      if (ch === "{") {
        depth++;
        opened = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    if (opened && depth <= 0) return i + 1;
  }
  return startLine;
}

/** `@relation(fields: [authorId], references: [id])` → field/reference names. */
function relationFromField(
  field: Field,
  target: string,
): { fieldNames: string[]; target: string; references: string[] } | null {
  const relation = (field.attributes ?? []).find((a) => a.name === "relation");
  if (!relation) return null;
  let fieldNames: string[] = [];
  let references: string[] = [];
  for (const arg of relation.args ?? []) {
    const value = arg.value;
    if (!isKeyValue(value)) continue;
    if (value.key === "fields") fieldNames = relationArrayNames(value.value);
    else if (value.key === "references") references = relationArrayNames(value.value);
  }
  if (fieldNames.length === 0) return null;
  return { fieldNames, target, references };
}

// ---------------------------------------------------------------------------

function firstArgValue(args: AttributeArgument[] | undefined): Value | KeyValue | undefined {
  return args?.[0]?.value;
}

function relationArrayNames(value: Value | KeyValue | undefined): string[] {
  if (!isRelationArray(value)) return [];
  return value.args.filter((v): v is string => typeof v === "string");
}

function hasFieldAttr(attributes: Attribute[] | undefined, name: string): boolean {
  return (attributes ?? []).some((a) => a.name === name);
}

function fieldAttrString(attributes: Attribute[] | undefined, name: string): string | null {
  const attr = (attributes ?? []).find((a) => a.name === name);
  const value = firstArgValue(attr?.args);
  return typeof value === "string" ? unquote(value) : null;
}

function isKeyValue(value: Value | KeyValue | undefined): value is KeyValue {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value.type === "keyValue"
    : false;
}

function isRelationArray(value: Value | KeyValue | undefined): value is RelationArray {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value.type === "array"
    : false;
}

/** prisma-ast keeps string literals quoted: '"users"' → 'users'. */
function unquote(value: string): string {
  return value.replace(/^["']|["']$/g, "");
}
