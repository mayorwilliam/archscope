import { parseNodeId } from "@archscope/schema";
import { useEffect, useMemo, useState } from "react";
import { useDocs, useMeta, useOverview, useSearch } from "../api/queries";
import type { ModuleSummary, SearchResult } from "../api/types";
import { navigate, type Route, useRoute } from "../router";
import { StalenessBar } from "./StalenessBar";

const NAV: Array<{ label: string; route: Route; testid: string }> = [
  { label: "Home", route: { view: "home" }, testid: "nav-home" },
  { label: "Graph", route: { view: "graph" }, testid: "nav-graph" },
  { label: "ERD", route: { view: "erd" }, testid: "nav-erd" },
  { label: "Timeline", route: { view: "timeline" }, testid: "nav-timeline" },
  { label: "Diff", route: { view: "diff" }, testid: "nav-diff" },
];

function basename(root: string): string {
  const parts = root.replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || root;
}

/** Search results land on wiki pages: modules and files → module page, docs → doc page. */
function goTo(result: SearchResult): void {
  if (result.kind === "doc") {
    navigate({ view: "doc", ref: parseNodeId(result.id).rest });
  } else if (result.kind === "module") {
    navigate({ view: "module", ref: result.id });
  } else if (result.moduleId !== undefined) {
    navigate({ view: "module", ref: result.moduleId });
  }
}

function SidebarSearch() {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 150);
    return () => clearTimeout(timer);
  }, [text]);

  const { data } = useSearch(query, "module,file,doc");
  const results = query.length > 0 ? (data?.results ?? []) : [];

  const pick = (result: SearchResult) => {
    setOpen(false);
    setText("");
    goTo(result);
  };

  return (
    <div className="sidebar-search">
      <input
        value={text}
        placeholder="Search…"
        data-testid="sidebar-search"
        onChange={(event) => {
          setText(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setText("");
            setOpen(false);
          } else if (event.key === "Enter" && results[0]) {
            pick(results[0]);
          }
        }}
      />
      {open && results.length > 0 && (
        <ul className="search-results" data-testid="sidebar-search-results">
          {results.map((result) => (
            <li key={result.id}>
              <button type="button" onClick={() => pick(result)}>
                <span className="kind-chip">{result.kind}</span>
                <span className="result-name">
                  {result.kind === "file" || result.kind === "doc"
                    ? parseNodeId(result.id).rest
                    : result.name}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Sidebar({ connected }: { connected: boolean }) {
  const route = useRoute();
  const { data: meta } = useMeta();
  const { data: overview } = useOverview();
  const { data: docs } = useDocs();

  // Modules grouped by layer (config order is lost server-side; name order is stable).
  const layers = useMemo(() => {
    const groups = new Map<string, ModuleSummary[]>();
    for (const mod of overview?.modules ?? []) {
      const layer = mod.layer ?? "";
      const list = groups.get(layer);
      if (list) list.push(mod);
      else groups.set(layer, [mod]);
    }
    return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [overview]);

  const projectDocs = (docs?.docs ?? []).filter((doc) => doc.module === undefined);

  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="brand">
        ArchScope
        {meta && <span className="project">{basename(meta.root)}</span>}
      </div>

      <SidebarSearch />

      <nav className="primary">
        {NAV.map((item) => (
          <button
            type="button"
            key={item.testid}
            data-testid={item.testid}
            className={
              route.view === item.route.view ||
              (item.route.view === "home" && (route.view === "module" || route.view === "doc"))
                ? "nav-item active"
                : "nav-item"
            }
            onClick={() => navigate(item.route)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <div className="tree">
        {layers.map(([layer, modules]) => (
          <div key={layer || "(none)"}>
            <h4>{layer === "" ? "Modules" : layer}</h4>
            {modules.map((mod) => (
              <button
                type="button"
                key={mod.id}
                data-testid="sidebar-module"
                className={
                  route.view === "module" && route.ref === mod.id ? "tree-item active" : "tree-item"
                }
                onClick={() => navigate({ view: "module", ref: mod.id })}
              >
                <span className="name">{mod.name}</span>
                <span className="count">{mod.files}</span>
              </button>
            ))}
          </div>
        ))}

        {projectDocs.length > 0 && (
          <div>
            <h4>Docs</h4>
            {projectDocs.map((doc) => (
              <button
                type="button"
                key={doc.id}
                data-testid="sidebar-doc"
                className={
                  route.view === "doc" && route.ref === doc.path ? "tree-item active" : "tree-item"
                }
                onClick={() => navigate({ view: "doc", ref: doc.path })}
              >
                <span className="name">{doc.title}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="sidebar-footer">
        {meta && (
          <span className="graph-counts" data-testid="graph-counts">
            {meta.counts.module ?? 0} modules · {meta.counts.file ?? 0} files
          </span>
        )}
        <StalenessBar connected={connected} />
      </div>
    </aside>
  );
}
