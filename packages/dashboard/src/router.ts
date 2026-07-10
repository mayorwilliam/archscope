import { useSyncExternalStore } from "react";

/** Hash routing: enough for four views, zero dependencies. */

export type Route =
  | { view: "overview" }
  | { view: "module"; ref: string }
  | { view: "erd" }
  | { view: "diff" };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/");
  if (parts[0] === "module" && parts[1]) {
    return { view: "module", ref: decodeURIComponent(parts.slice(1).join("/")) };
  }
  if (parts[0] === "erd") return { view: "erd" };
  if (parts[0] === "diff") return { view: "diff" };
  return { view: "overview" };
}

export function routeHash(route: Route): string {
  switch (route.view) {
    case "overview":
      return "#/";
    case "module":
      return `#/module/${encodeURIComponent(route.ref)}`;
    case "erd":
      return "#/erd";
    case "diff":
      return "#/diff";
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
