/**
 * Stable, path-based node IDs. This module is the ONLY place where IDs are
 * constructed or parsed — every other package must go through these functions.
 *
 * IDs are content-independent so that diffing two snapshots reduces to set
 * arithmetic over ID strings. Renames are handled by the diff engine via
 * git rename detection, never by the ID scheme itself.
 *
 * Paths inside IDs are always repo-relative and use forward slashes.
 */

export type NodeId = string;

const SEP = ":";
const SYMBOL_SEP = "#";

export type NodeIdKind = "mod" | "file" | "sym" | "ent" | "tbl" | "pkg" | "doc";

export function moduleId(name: string): NodeId {
  return `mod${SEP}${name}`;
}

export function fileId(relPath: string): NodeId {
  return `file${SEP}${normalizePath(relPath)}`;
}

export function symbolId(relPath: string, symbolName: string): NodeId {
  return `sym${SEP}${normalizePath(relPath)}${SYMBOL_SEP}${symbolName}`;
}

export function entityId(relPath: string, entityName: string): NodeId {
  return `ent${SEP}${normalizePath(relPath)}${SYMBOL_SEP}${entityName}`;
}

/** `schema` is the DB schema (e.g. "public"), not the table's columns. */
export function tableId(schema: string, table: string): NodeId {
  return `tbl${SEP}${schema}.${table}`;
}

export function packageId(packageName: string): NodeId {
  return `pkg${SEP}${packageName}`;
}

export function docId(relPath: string): NodeId {
  return `doc${SEP}${normalizePath(relPath)}`;
}

export interface ParsedNodeId {
  kind: NodeIdKind;
  /** Everything after `kind:`. For sym/ent this still contains the `#`. */
  rest: string;
  /** Only for sym/ent: the path part before `#`. */
  path?: string;
  /** Only for sym/ent: the name part after `#`. */
  name?: string;
}

const ID_RE = /^(mod|file|sym|ent|tbl|pkg|doc):(.+)$/;

export function parseNodeId(id: NodeId): ParsedNodeId {
  const m = ID_RE.exec(id);
  if (!m) throw new Error(`Invalid node id: ${id}`);
  const kind = m[1] as NodeIdKind;
  const rest = m[2] as string;
  if (kind === "sym" || kind === "ent") {
    const hash = rest.indexOf(SYMBOL_SEP);
    if (hash === -1) throw new Error(`Invalid ${kind} id (missing '#'): ${id}`);
    return { kind, rest, path: rest.slice(0, hash), name: rest.slice(hash + 1) };
  }
  return { kind, rest };
}

export function isNodeId(value: string): boolean {
  return ID_RE.test(value);
}

/**
 * Deterministic edge ID. Two graphs built from the same facts always produce
 * identical edge IDs, which is what makes snapshot diffing set arithmetic.
 */
export function edgeId(kind: string, from: NodeId, to: NodeId): string {
  return `${kind}|${from}|${to}`;
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "");
}
