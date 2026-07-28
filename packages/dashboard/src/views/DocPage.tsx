import { useDoc } from "../api/queries";
import { Markdown } from "../components/Markdown";
import { navigate } from "../router";

/** One markdown doc as a full wiki page. */
export function DocPage({ docRef }: { docRef: string }) {
  const { data: doc, error, isPending } = useDoc(docRef);

  return (
    <div className="wiki-scroll">
      <div className="wiki-page" data-testid="doc-page">
        {isPending && <div className="empty-note">Loading…</div>}
        {error && <div className="empty-note">{error.message}</div>}
        {doc && (
          <>
            <header className="page-header">
              <div className="page-kicker">
                {doc.path}
                {doc.module && (
                  <button
                    type="button"
                    className="link-btn"
                    onClick={() => doc.module && navigate({ view: "module", ref: doc.module.id })}
                  >
                    → {doc.module.name}
                  </button>
                )}
              </div>
            </header>
            <div className="card">
              <Markdown content={doc.content} basePath={doc.path} />
              {doc.truncated && (
                <div className="doc-truncated-note">
                  Stored content was capped at extraction — open the file for the full text.
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
