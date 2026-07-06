import { z } from "zod";
import { DriftEntrySchema, EdgeKindSchema } from "./graph.js";

/**
 * ArchDiff: the result of comparing two graph snapshots.
 * File-level changes are the detail layer; the headline is the module-level
 * aggregation (new module→module dependencies are the alarm bell).
 */

export const RefInfoSchema = z.object({
  sha: z.string(),
  ref: z.string().optional(),
});
export type RefInfo = z.infer<typeof RefInfoSchema>;

export const EdgeRefSchema = z.object({
  kind: EdgeKindSchema,
  from: z.string(),
  to: z.string(),
});
export type EdgeRef = z.infer<typeof EdgeRefSchema>;

export const FieldDeltaSchema = z.object({
  field: z.string(),
  before: z.string(),
  after: z.string(),
});
export type FieldDelta = z.infer<typeof FieldDeltaSchema>;

export const NodeChangeSchema = z.object({
  id: z.string(),
  change: z.enum(["added", "removed", "changed", "moved"]),
  /** For "moved": the previous id. */
  previousId: z.string().optional(),
  /** For "changed": structured field-level deltas. */
  deltas: z.array(FieldDeltaSchema).optional(),
});
export type NodeChange = z.infer<typeof NodeChangeSchema>;

export const EdgeChangeSchema = z.object({
  edge: EdgeRefSchema,
  change: z.enum(["added", "removed"]),
});
export type EdgeChange = z.infer<typeof EdgeChangeSchema>;

export const WeightDeltaSchema = z.object({
  edge: EdgeRefSchema,
  before: z.number(),
  after: z.number(),
});
export type WeightDelta = z.infer<typeof WeightDeltaSchema>;

export const ArchDiffSchema = z.object({
  base: RefInfoSchema,
  head: RefInfoSchema,
  moduleChanges: z.object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    renamed: z.array(z.tuple([z.string(), z.string()])),
  }),
  dependencyChanges: z.object({
    added: z.array(EdgeRefSchema),
    removed: z.array(EdgeRefSchema),
    weightDelta: z.array(WeightDeltaSchema),
  }),
  dbChanges: z.object({
    tables: z.array(NodeChangeSchema),
    fks: z.array(EdgeChangeSchema),
    driftDelta: z.array(DriftEntrySchema),
  }),
  /** Detail layer — drill-down only, never the headline. */
  fileChanges: z.array(NodeChangeSchema),
});
export type ArchDiff = z.infer<typeof ArchDiffSchema>;

export function parseArchDiff(data: unknown): ArchDiff {
  return ArchDiffSchema.parse(data);
}
