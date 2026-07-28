import { useSyncExternalStore } from "react";

/** Hash routing: enough for a wiki + canvas views, zero dependencies. */

export type Route =
  | { view: "home" }
  | { view: "module"; ref: string }
  | { view: "doc"; ref: string }
  | { view: "graph" }
  | { view: "erd" }
  | { view: "diff"; base?: string; head?: string }
  | { view: "timeline" };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/");
  if (parts[0] === "module" && parts[1]) {
    return { view: "module", ref: decodeURIComponent(parts.slice(1).join("/")) };
  }
  if (parts[0] === "doc" && parts[1]) {
    return { view: "doc", ref: decodeURIComponent(parts.slice(1).join("/")) };
  }
  if (parts[0] === "graph") return { view: "graph" };
  if (parts[0] === "erd") return { view: "erd" };
  if (parts[0] === "diff") {
    // #/diff/<base>..<head> — linkable comparisons. ".." never appears in a
    // valid git refname, so the separator is unambiguous.
    const range = parts.slice(1).join("/");
    const sep = range.indexOf("..");
    if (sep > 0) {
      return {
        view: "diff",
        base: decodeURIComponent(range.slice(0, sep)),
        head: decodeURIComponent(range.slice(sep + 2)) || "HEAD",
      };
    }
    return { view: "diff" };
  }
  if (parts[0] === "timeline") return { view: "timeline" };
  return { view: "home" };
}

export function routeHash(route: Route): string {
  switch (route.view) {
    case "home":
      return "#/";
    case "module":
      return `#/module/${encodeURIComponent(route.ref)}`;
    case "doc":
      return `#/doc/${encodeURIComponent(route.ref)}`;
    case "graph":
      return "#/graph";
    case "erd":
      return "#/erd";
    case "diff":
      return route.base !== undefined
        ? `#/diff/${encodeURIComponent(route.base)}..${encodeURIComponent(route.head ?? "HEAD")}`
        : "#/diff";
    case "timeline":
      return "#/timeline";
  }
}

export function navigate(route: Route): void {
  window.location.hash = routeHash(route);
}

function subscribe(callback: () => void): () => void {
  window.addEventListener("hashchange", callback);
  return () => window.removeEventListener("hashchange", callback);
}

export function useRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  return parseHash(hash);
}
