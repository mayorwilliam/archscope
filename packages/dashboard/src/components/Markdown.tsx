import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { navigate } from "../router";

/**
 * Markdown → React, safe by construction: react-markdown never injects raw
 * HTML (no dangerouslySetInnerHTML anywhere). Relative `.md` links become
 * wiki routes so READMEs cross-link into the wiki instead of 404ing.
 */

/** Resolve `../other/README.md` against the doc's own repo-relative path. */
function resolveRelative(href: string, basePath: string): string {
  const baseDir = basePath.includes("/") ? basePath.slice(0, basePath.lastIndexOf("/")) : "";
  const segments = baseDir === "" ? [] : baseDir.split("/");
  for (const part of href.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segments.pop();
    else segments.push(part);
  }
  return segments.join("/");
}

export function Markdown({ content, basePath }: { content: string; basePath: string }) {
  return (
    <div className="prose">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => {
            const target = href ?? "";
            const isExternal = /^[a-z]+:/i.test(target);
            if (!isExternal && /\.md(#.*)?$/i.test(target)) {
              const docPath = resolveRelative(target.replace(/#.*$/, ""), basePath);
              return (
                <a
                  href={`#/doc/${encodeURIComponent(docPath)}`}
                  onClick={(event) => {
                    event.preventDefault();
                    navigate({ view: "doc", ref: docPath });
                  }}
                >
                  {children}
                </a>
              );
            }
            return (
              <a href={target} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
