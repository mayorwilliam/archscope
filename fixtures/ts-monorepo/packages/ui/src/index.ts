// Cross-workspace import via package name: must resolve to core-lib SOURCE
// (dist/ is declared in its package.json but never built).
import { add } from "@fix/core";
// Subpath import into a workspace package.
import { clamp } from "@fix/core/helpers";

export function render(width: number): string {
  return `w=${clamp(add(width, 10), 0, 100)}`;
}
