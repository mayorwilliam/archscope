import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type {
  DiffResponse,
  ErdView,
  MetaResponse,
  ModuleView,
  OverviewView,
  RefsResponse,
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

export function useErd() {
  return useQuery({ queryKey: ["erd"], queryFn: () => getJson<ErdView>("/api/erd") });
}

export function useRefs() {
  return useQuery({ queryKey: ["refs"], queryFn: () => getJson<RefsResponse>("/api/refs") });
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
