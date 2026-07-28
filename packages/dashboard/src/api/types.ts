import type { GitRef, ModuleSummary, OverviewView, StalenessInfo } from "@archscope/core";
import type { ArchDiff, GitInfo } from "@archscope/schema";

/**
 * The dashboard consumes core/query view-models VERBATIM — these re-exports
 * are the whole data contract. If a view needs a fact that is not in a
 * view-model, the view-model grows in core (where it is tested and shared
 * with MCP), never here.
 */

export type {
  DocListItem,
  DocModuleRef,
  DocsView,
  DocView,
  ErdTable,
  ErdView,
  FileContextView,
  FileExport,
  FileSummary,
  ModuleDependency,
  ModuleReadme,
  ModuleSummary,
  ModuleView,
  OverviewView,
  SchemaDriftView,
  SearchResult,
  SearchView,
  StalenessInfo,
  TableEntityRef,
  TimelinePoint,
  TimelineView,
} from "@archscope/core";
export type { ArchDiff, DriftEntry, TableColumn } from "@archscope/schema";

export interface MetaResponse {
  staleness: StalenessInfo;
  root: string;
  counts: Record<string, number>;
  toolVersion: string;
  live: { source: string; dialect: string; introspectedAt: string } | null;
}

export interface RefsResponse {
  refs: GitRef[];
  head: GitInfo | null;
}

export interface DiffResponse {
  diff: ArchDiff;
  headOverview: OverviewView;
}

export interface SourceResponse {
  path: string;
  startLine: number;
  endLine: number;
  lines: string[];
}

export interface TimelinePointResponse {
  sha: string;
  counts: Record<string, number>;
  modules: ModuleSummary[];
}
