import { useSource } from "../api/queries";

/**
 * A read-only slice of a source file, addressed by the span the graph already
 * carries. The server only serves paths that exist as graph nodes — this
 * displays bytes the graph points at, it never derives new facts.
 */
export function SourceExcerpt({
  path,
  startLine,
  endLine,
}: {
  path: string;
  startLine: number;
  endLine: number;
}) {
  const { data, error, isPending } = useSource(path, startLine, endLine);

  return (
    <div className="source-excerpt" data-testid="source-excerpt">
      <div className="source-head">
        {path} · L{startLine}–{endLine}
      </div>
      {isPending && <pre className="muted"> loading…</pre>}
      {error && <pre className="muted"> {error.message}</pre>}
      {data && (
        <pre>
          {data.lines
            .map((line, i) => ({ no: data.startLine + i, line }))
            .map(({ no, line }) => (
              <div key={no}>
                <span className="line-no">{no}</span>
                {line}
              </div>
            ))}
        </pre>
      )}
    </div>
  );
}
