import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { FileFacts } from "../parse/facts.js";

/**
 * Incremental extraction cache: FileFacts keyed by content hash.
 *
 * The key embeds EXTRACTOR_VERSION and the repo-relative path along with the
 * file's bytes, so invalidation needs no logic at all — a changed file, a
 * moved file, or a smarter extractor each simply produce a different key.
 * Stale entries are never wrong, only unused. Global resolution is always
 * recomputed from facts; only parsing (the expensive part) is cached.
 */

/** Bump whenever extraction output changes shape or semantics. */
export const EXTRACTOR_VERSION = 3; // v3: TypeORM/Drizzle/Django extractors (phase 6)

export interface CacheStats {
  hits: number;
  /** Files extracted (cache disabled counts every file here). */
  misses: number;
}

export function factsKey(relPath: string, source: string): string {
  return crypto
    .createHash("sha1")
    .update(`archscope-facts\n${EXTRACTOR_VERSION}\n${relPath}\n`)
    .update(source)
    .digest("hex");
}

export class FactsCache {
  private readonly dir: string;
  private dirReady = false;

  constructor(dir: string) {
    this.dir = dir;
  }

  get(key: string): FileFacts | null {
    try {
      const raw = fs.readFileSync(path.join(this.dir, `${key}.json`), "utf8");
      return JSON.parse(raw) as FileFacts;
    } catch {
      return null; // missing or unreadable — both are just a miss
    }
  }

  put(key: string, facts: FileFacts): void {
    if (!this.dirReady) {
      fs.mkdirSync(this.dir, { recursive: true });
      this.dirReady = true;
    }
    fs.writeFileSync(path.join(this.dir, `${key}.json`), JSON.stringify(facts));
  }
}
