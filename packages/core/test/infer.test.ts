import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArchscopeConfig } from "@archscope/schema";
import { afterAll, describe, expect, it } from "vitest";
import { createModuleInferrer } from "../src/modules/infer.js";
import { discoverWorkspacePackages } from "../src/resolve/workspace.js";

const noConfig = parseArchscopeConfig({});

describe("module inference (tier 3: directory heuristic)", () => {
  const infer = createModuleInferrer("/repo/myapp", noConfig, []);

  it("groups by first-level directory under src/", () => {
    expect(infer("src/auth/login.ts").moduleName).toBe("auth");
    expect(infer("lib/router.ts").moduleName).toBe("lib");
  });

  it("sends loose root files to the root module", () => {
    expect(infer("main.ts").moduleName).toBe("myapp");
    expect(infer("src/index.ts").moduleName).toBe("myapp");
  });

  it("descends one level inside well-known container dirs", () => {
    // Undeclared monorepo (lerna without workspaces field): packages/* must
    // split into real packages, not lump into one "packages" module.
    expect(infer("packages/common/decorators/bind.ts").moduleName).toBe("common");
    expect(infer("apps/web/pages/home.tsx").moduleName).toBe("web");
    expect(infer("libs/shared/util.ts").moduleName).toBe("shared");
  });

  it("does not descend when the container holds loose files", () => {
    expect(infer("packages/tsconfig.json.ts").moduleName).toBe("packages");
  });

  it("config rules beat everything", () => {
    const config = parseArchscopeConfig({
      modules: [{ name: "API", layer: "api", include: ["src/auth/**"] }],
    });
    const inferWithConfig = createModuleInferrer("/repo/myapp", config, []);
    const result = inferWithConfig("src/auth/login.ts");
    expect(result).toEqual({ moduleName: "API", layer: "api", source: "config" });
  });
});

describe("workspace discovery via lerna.json", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "archscope-lerna-"));

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("reads packages from lerna.json when no workspaces field exists", () => {
    fs.writeFileSync(path.join(tmp, "lerna.json"), JSON.stringify({ packages: ["packages/*"] }));
    fs.writeFileSync(path.join(tmp, "package.json"), JSON.stringify({ name: "root" }));
    fs.mkdirSync(path.join(tmp, "packages/common"), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, "packages/common/package.json"),
      JSON.stringify({ name: "@nest/common" }),
    );

    const found = discoverWorkspacePackages(tmp);
    expect(found).toEqual([{ name: "@nest/common", dir: path.join(tmp, "packages/common") }]);
  });
});
