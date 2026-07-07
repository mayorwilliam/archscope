export { CONFIG_FILENAME, loadConfig } from "./config-file.js";
export { type DiffInput, diffGraphs } from "./diff/engine.js";
export { gitRenames } from "./diff/rename.js";
export { gitInfo } from "./git.js";
export { type BuildInput, buildGraph } from "./graph/build.js";
export { pageRank } from "./graph/metrics.js";
export {
  createModuleInferrer,
  type ModuleAssignment,
  type ModuleInferrer,
} from "./modules/infer.js";
export type { FileFacts, ImportFact, ImportKind, OrmHint, SymbolFact } from "./parse/facts.js";
export { grammarForFile, initParser } from "./parse/parser.js";
export { extractPyFacts } from "./parse/py.js";
export { extractTsFacts } from "./parse/ts.js";
export { type AnalyzeOptions, type AnalyzeResult, analyze } from "./pipeline.js";
export { PyResolver } from "./resolve/py-resolver.js";
export {
  CombinedResolver,
  type ImportResolver,
  type ResolvedImport,
} from "./resolve/resolver.js";
export { packageNameOf, type Resolution, TsResolver } from "./resolve/ts-resolver.js";
export { discoverWorkspacePackages, type WorkspacePackage } from "./resolve/workspace.js";
export { scanSourceFiles } from "./scan.js";
export { type EnsureSnapshotResult, ensureSnapshot, resolveRef } from "./snapshot.js";
export { type CacheStats, EXTRACTOR_VERSION, FactsCache, factsKey } from "./store/cache.js";
export { Store } from "./store/store.js";
