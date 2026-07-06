import { z } from "zod";
import { EdgeKindSchema } from "./graph.js";

/**
 * Schema for `.archmap.yaml` — the committed, user-owned config.
 * Everything is optional: a repo with no config still analyzes with
 * workspace + directory heuristics.
 */

export const ModuleRuleSchema = z.object({
  name: z.string(),
  layer: z.string().optional(),
  include: z.array(z.string()).min(1),
});
export type ModuleRule = z.infer<typeof ModuleRuleSchema>;

/**
 * Manual edges: the escape hatch for dependencies static analysis cannot see
 * (dynamic imports, plugin registries). Rendered dashed in the dashboard and
 * labeled `manual` in MCP output — never silently mixed with static facts.
 */
export const ManualEdgeSchema = z.object({
  from: z.string(),
  to: z.string(),
  kind: EdgeKindSchema,
  reason: z.string().optional(),
});
export type ManualEdge = z.infer<typeof ManualEdgeSchema>;

export const DbLiveSourceSchema = z.object({
  name: z.string(),
  dialect: z.enum(["postgres", "mysql"]),
  /** Name of the env var holding the connection URL. The VALUE never touches disk. */
  urlEnv: z.string(),
});
export type DbLiveSource = z.infer<typeof DbLiveSourceSchema>;

export const ArchmapConfigSchema = z.object({
  version: z.literal(1).default(1),
  /** Ordered top→bottom; drives the dashboard's vertical layout. */
  layers: z.array(z.string()).optional(),
  modules: z.array(ModuleRuleSchema).optional(),
  edges: z.array(ManualEdgeSchema).optional(),
  /** Globs excluded from analysis entirely (generated code, vendored dirs). */
  exclude: z.array(z.string()).optional(),
  python: z
    .object({
      sourceRoots: z.array(z.string()).optional(),
    })
    .optional(),
  db: z
    .object({
      /** "auto" detects ORM files; an array restricts to specific extractors. */
      static: z.union([z.literal("auto"), z.array(z.string())]).optional(),
      live: z.array(DbLiveSourceSchema).optional(),
    })
    .optional(),
});
export type ArchmapConfig = z.infer<typeof ArchmapConfigSchema>;

export function parseArchmapConfig(data: unknown): ArchmapConfig {
  return ArchmapConfigSchema.parse(data ?? {});
}
