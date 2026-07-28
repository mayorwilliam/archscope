import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { execa } from "execa";
import { buildFixtureRepo, CLI_BIN, injectDrift, type ServeHandle, startServe } from "./fixture";

/**
 * Acceptance smoke: wiki home with README prose, module wiki page with the
 * embedded neighborhood graph, the full canvas at #/graph (module count,
 * expand/collapse), ERD with FKs + drift badge, colored diff, and a live
 * update (edit → view refresh) in under 2 seconds without a reload.
 *
 * Fixture shape is pinned (see fixture.ts): 4 modules (auth, billing,
 * prisma, utils), 5 files, 3 tables, 2 FKs, 2 READMEs.
 */

test.describe.configure({ mode: "serial" });

let repo: string;
let server: ServeHandle;

test.beforeAll(async () => {
  repo = await buildFixtureRepo();
  await execa(process.execPath, [CLI_BIN, "analyze"], { cwd: repo });
  server = await startServe(repo);
});

test.afterAll(async () => {
  await server?.stop();
});

test("the wiki home renders the project README as prose with stats", async ({ page }) => {
  await page.goto(server.url);
  await expect(page.getByTestId("wiki-home")).toBeVisible();
  await expect(page.getByTestId("wiki-readme")).toContainText("Fixture App");
  await expect(page.getByTestId("home-module-card").first()).toBeVisible();
  await expect(page.getByTestId("graph-counts")).toHaveText("4 modules · 5 files");
});

test("a module wiki page shows prose, metrics and the embedded graph", async ({ page }) => {
  await page.goto(server.url);
  await page.locator('[data-testid="sidebar-module"]', { hasText: "auth" }).click();
  await expect(page.getByTestId("module-page")).toBeVisible();
  await expect(page.getByTestId("module-readme")).toContainText("Login and session handling");
  await expect(page.getByTestId("module-minigraph")).toBeVisible();
  await expect(page.getByTestId("module-file-row")).toHaveCount(2);
});

test("the graph view shows every module and the graph counts", async ({ page }) => {
  await page.goto(`${server.url}/#/graph`);
  await expect(page.getByTestId("module-node")).toHaveCount(4);
  await expect(page.getByTestId("graph-counts")).toHaveText("4 modules · 5 files");
  for (const name of ["auth", "billing", "prisma", "utils"]) {
    await expect(page.locator(`[data-module-id="mod:${name}"]`)).toBeVisible();
  }
  await expect(page.getByTestId("live-dot")).toHaveAttribute("data-connected", "true");
});

test("a module expands into its files and collapses back", async ({ page }) => {
  await page.goto(`${server.url}/#/graph`);
  await page.locator('[data-module-id="mod:auth"] [data-testid="expand-btn"]').click();
  await expect(page.getByTestId("module-group")).toHaveCount(1);
  await expect(page.getByTestId("file-node")).toHaveCount(2);

  await page.getByTestId("collapse-btn").click();
  await expect(page.getByTestId("module-group")).toHaveCount(0);
  await expect(page.getByTestId("file-node")).toHaveCount(0);
  await expect(page.getByTestId("module-node")).toHaveCount(4);
});

test("ERD draws tables with PK/FK marks, FK edges and a drift badge", async ({ page }) => {
  injectDrift(repo, "User");
  await page.goto(`${server.url}/#/erd`);

  await expect(page.getByTestId("table-node")).toHaveCount(3);
  await expect(page.locator(".react-flow__edge.edge-fk")).toHaveCount(2);
  const userTable = page.locator('[data-table-id="tbl:public.User"]');
  await expect(userTable.locator(".key.pk")).toHaveCount(1);
  await expect(userTable.locator(".key.fk")).toHaveCount(1);
  await expect(page.getByTestId("drift-badge")).toHaveText("⚠ 1");

  await userTable.click();
  await expect(page.getByTestId("drift-entries")).toContainText("bio");
});

test("diff overlays added/removed in color and lists every change", async ({ page }) => {
  await page.goto(`${server.url}/#/diff`);
  await page.getByTestId("diff-base").selectOption("base");
  await page.getByTestId("diff-compare").click();

  // Snapshots for both refs are built on demand — give the first diff time.
  const addedModule = page.locator('[data-testid="module-node"][data-status="added"]');
  await expect(addedModule).toContainText("billing", { timeout: 90_000 });
  await expect(page.locator('[data-testid="module-node"][data-status="removed"]')).toContainText(
    "legacy",
  );
  await expect(page.locator(".react-flow__edge.edge-added")).toHaveCount(1);
  await expect(page.locator(".react-flow__edge.edge-removed")).toHaveCount(1);

  await expect(page.getByTestId("change-module-added")).toContainText("billing");
  await expect(page.getByTestId("change-module-removed")).toContainText("legacy");
  await expect(page.getByTestId("change-dep-added")).toContainText("billing → utils");
  await expect(page.getByTestId("change-dep-removed")).toContainText("legacy → utils");
  await expect(page.getByTestId("change-table")).toContainText("User");
  await expect(page.getByTestId("change-table")).toContainText("bio");
});

test("editing a file updates the open view in <2s without a reload", async ({ page }) => {
  await page.goto(server.url);
  await expect(page.getByTestId("graph-counts")).toHaveText("4 modules · 5 files");

  await page.evaluate(() => {
    (window as unknown as { __noReload?: boolean }).__noReload = true;
  });
  fs.writeFileSync(
    path.join(repo, "utils", "extra.ts"),
    "export function extra(): number {\n  return 1;\n}\n",
  );

  // The acceptance criterion, literally: updated in under 2 seconds.
  await expect(page.getByTestId("graph-counts")).toHaveText("4 modules · 6 files", {
    timeout: 2_000,
  });
  expect(
    await page.evaluate(() => (window as unknown as { __noReload?: boolean }).__noReload),
  ).toBe(true);
});
