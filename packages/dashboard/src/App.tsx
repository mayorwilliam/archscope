import { useGraphEvents, useMeta } from "./api/queries";
import { StalenessBar } from "./components/StalenessBar";
import { navigate, useRoute } from "./router";
import { DiffScreen } from "./views/DiffScreen";
import { ErdScreen } from "./views/ErdScreen";
import { ModuleScreen } from "./views/ModuleScreen";
import { OverviewScreen } from "./views/OverviewView";

const TABS = [
  { label: "Overview", view: "overview" },
  { label: "ERD", view: "erd" },
  { label: "Diff", view: "diff" },
] as const;

export function App() {
  const route = useRoute();
  const connected = useGraphEvents();
  const { data: meta } = useMeta();

  return (
    <div className="app">
      <header className="topbar">
        <span className="brand">ArchScope</span>
        <nav className="tabs">
          {TABS.map((tab) => (
            <button
              type="button"
              key={tab.view}
              className={
                route.view === tab.view || (tab.view === "overview" && route.view === "module")
                  ? "active"
                  : ""
              }
              data-testid={`tab-${tab.view}`}
              onClick={() => navigate({ view: tab.view })}
            >
              {tab.label}
            </button>
          ))}
        </nav>
        {route.view === "module" && (
          <span style={{ fontSize: 13, color: "var(--muted)" }} data-testid="breadcrumb">
            → {route.ref.replace(/^mod:/, "")}
          </span>
        )}
        {meta && (
          <span style={{ fontSize: 12, color: "var(--muted)" }} data-testid="graph-counts">
            {meta.counts.module ?? 0} modules · {meta.counts.file ?? 0} files
          </span>
        )}
        <StalenessBar connected={connected} />
      </header>

      {route.view === "overview" && <OverviewScreen />}
      {route.view === "module" && <ModuleScreen moduleRef={route.ref} key={route.ref} />}
      {route.view === "erd" && <ErdScreen />}
      {route.view === "diff" && <DiffScreen />}
    </div>
  );
}
