import { useGraphEvents } from "./api/queries";
import { Sidebar } from "./components/Sidebar";
import { useRoute } from "./router";
import { DiffScreen } from "./views/DiffScreen";
import { DocPage } from "./views/DocPage";
import { ErdScreen } from "./views/ErdScreen";
import { GraphScreen } from "./views/GraphScreen";
import { ModulePage } from "./views/ModulePage";
import { TimelineScreen } from "./views/TimelineScreen";
import { WikiHome } from "./views/WikiHome";

/**
 * Shell: persistent sidebar (nav + search + module tree) and one content
 * view. The wiki pages are the primary surface; the canvas views (graph,
 * ERD, diff) live alongside them as equals — not as THE interface.
 */
export function App() {
  const route = useRoute();
  const connected = useGraphEvents();

  return (
    <div className="app">
      <Sidebar connected={connected} />
      <main className="content">
        {route.view === "home" && <WikiHome />}
        {route.view === "module" && <ModulePage moduleRef={route.ref} key={route.ref} />}
        {route.view === "doc" && <DocPage docRef={route.ref} key={route.ref} />}
        {route.view === "graph" && <GraphScreen />}
        {route.view === "erd" && <ErdScreen />}
        {route.view === "diff" && <DiffScreen />}
        {route.view === "timeline" && <TimelineScreen />}
      </main>
    </div>
  );
}
