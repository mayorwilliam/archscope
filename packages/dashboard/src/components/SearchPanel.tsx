import { parseNodeId } from "@archscope/schema";
import { useEffect, useState } from "react";
import { useSearch } from "../api/queries";
import type { SearchResult } from "../api/types";

/**
 * Overlay search box: type to filter modules and files (server-side, same
 * searchView the MCP tool uses), pick a result to fly the canvas to its node.
 */
export function SearchPanel({ onPick }: { onPick: (result: SearchResult) => void }) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), 150);
    return () => clearTimeout(timer);
  }, [text]);

  const { data } = useSearch(query);
  const results = query.length > 0 ? (data?.results ?? []) : [];

  const pick = (result: SearchResult) => {
    setOpen(false);
    onPick(result);
  };

  return (
    <div className="search-panel" data-testid="search-panel">
      <input
        value={text}
        placeholder="Search modules & files…"
        data-testid="search-input"
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
        <ul className="search-results" data-testid="search-results">
          {results.map((result) => (
            <li key={result.id}>
              <button type="button" onClick={() => pick(result)}>
                <span className="kind-chip">{result.kind}</span>
                <span className="result-name">
                  {/* Files show their full path — several files share a basename. */}
                  {result.kind === "file" ? parseNodeId(result.id).rest : result.name}
                </span>
                {result.kind === "file" && result.moduleId !== undefined && (
                  <span className="result-module">{result.moduleId.replace(/^mod:/, "")}</span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
