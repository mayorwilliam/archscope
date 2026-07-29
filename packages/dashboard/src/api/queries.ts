import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type {
  DiffResponse,
  DocsView,
  DocView,
  ErdView,
  FileContextView,
  FileHistoryResponse,
  MetaResponse,
  ModuleView,
  OverviewView,
  RefsResponse,
  SearchView,
  SourceResponse,
  TimelinePointResponse,
  TimelineView,
} from "./types";

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (body as { error?: string }).error ?? `${response.status} ${url}`;
    throw new Error(message);
  }
  return body as T;
}

export function useMeta() {
  return useQuery({ queryKey: ["meta"], queryFn: () => getJson<MetaResponse>("/api/meta") });
}

export function useOverview() {
  return useQuery({
    queryKey: ["overview"],
    queryFn: () => getJson<OverviewView>("/api/overview"),
  });
}

export function useModule(ref: string | null) {
  return useQuery({
    queryKey: ["module", ref],
    queryFn: () => getJson<ModuleView>(`/api/module?ref=${encodeURIComponent(ref ?? "")}`),
    enabled: ref !== null,
  });
}

/** Files of every expanded module, loaded lazily as the user expands. */
export function useModules(refs: string[]) {
  const client = useQueryClient();
  return useQuery({
    queryKey: ["modules", refs],
    queryFn: () =>
      Promise.all(
        refs.map((ref) =>
          client.fetchQuery({
            queryKey: ["module", ref],
            queryFn: () => getJson<ModuleView>(`/api/module?ref=${encodeURIComponent(ref)}`),
          }),
        ),
      ),
  });
}

/** Server-side node search — same searchView the MCP tool consumes. */
export function useSearch(query: string, kinds = "module,file") {
  return useQuery({
    queryKey: ["search", query, kinds],
    queryFn: () => getJson<SearchView>(`/api/search?q=${encodeURIComponent(query)}&kinds=${kinds}`),
    enabled: query.length > 0,
    placeholderData: (previous: SearchView | undefined) => previous,
  });
}

export function useErd() {
  return useQuery({ queryKey: ["erd"], queryFn: () => getJson<ErdView>("/api/erd") });
}

export function useDocs() {
  return useQuery({ queryKey: ["docs"], queryFn: () => getJson<DocsView>("/api/docs") });
}

export function useFileContext(ref: string | null) {
  return useQuery({
    queryKey: ["file", ref],
    queryFn: () => getJson<FileContextView>(`/api/file?ref=${encodeURIComponent(ref ?? "")}`),
    enabled: ref !== null,
  });
}

/** Recent commits touching one file — live git state, like the timeline. */
export function useFileHistory(path: string | null, limit = 10) {
  return useQuery({
    queryKey: ["file-history", path, limit],
    queryFn: () =>
      getJson<FileHistoryResponse>(
        `/api/file/history?path=${encodeURIComponent(path ?? "")}&limit=${limit}`,
      ),
    enabled: path !== null,
  });
}

export function useDoc(ref: string | null) {
  return useQuery({
    queryKey: ["doc", ref],
    queryFn: () => getJson<DocView>(`/api/doc?ref=${encodeURIComponent(ref ?? "")}`),
    enabled: ref !== null,
  });
}

/** Line range of a file the graph knows about — display bytes, not new facts. */
export function useSource(path: string | null, start: number, end: number) {
  return useQuery({
    queryKey: ["source", path, start, end],
    queryFn: () =>
      getJson<SourceResponse>(
        `/api/source?path=${encodeURIComponent(path ?? "")}&start=${start}&end=${end}`,
      ),
    enabled: path !== null,
  });
}

export function useRefs() {
  return useQuery({ queryKey: ["refs"], queryFn: () => getJson<RefsResponse>("/api/refs") });
}

export function useTimeline(commits: number) {
  return useQuery({
    queryKey: ["timeline", commits],
    queryFn: () => getJson<TimelineView>(`/api/timeline?commits=${commits}`),
  });
}

/** First fetch for a sha materializes its snapshot server-side — can take seconds. */
export function useTimelinePoint(sha: string | null) {
  return useQuery({
    queryKey: ["timeline-point", sha],
    queryFn: () =>
      getJson<TimelinePointResponse>(`/api/timeline/point?sha=${encodeURIComponent(sha ?? "")}`),
    enabled: sha !== null,
    staleTime: Number.POSITIVE_INFINITY, // snapshots are immutable per sha
  });
}

export function useDiff(base: string | null, head: string) {
  return useQuery({
    queryKey: ["diff", base, head],
    queryFn: () =>
      getJson<DiffResponse>(
        `/api/diff?base=${encodeURIComponent(base ?? "")}&head=${encodeURIComponent(head)}`,
      ),
    enabled: base !== null,
  });
}

/**
 * One EventSource for the whole app: `graph-updated` invalidates every query,
 * so any visible view refetches — that is the entire live-update mechanism.
 */
export function useGraphEvents(): boolean {
  const client = useQueryClient();
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const events = new EventSource("/api/events");
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    events.addEventListener("graph-updated", () => {
      client.invalidateQueries();
    });
    return () => events.close();
  }, [client]);

  return connected;
}
