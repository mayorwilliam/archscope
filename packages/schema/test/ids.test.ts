import { describe, expect, it } from "vitest";
import {
  edgeId,
  entityId,
  fileId,
  isNodeId,
  moduleId,
  normalizePath,
  packageId,
  parseNodeId,
  symbolId,
  tableId,
} from "../src/ids.js";

describe("node IDs", () => {
  it("constructs each kind with its prefix", () => {
    expect(moduleId("auth")).toBe("mod:auth");
    expect(fileId("src/auth/login.ts")).toBe("file:src/auth/login.ts");
    expect(symbolId("src/auth/login.ts", "loginUser")).toBe("sym:src/auth/login.ts#loginUser");
    expect(entityId("src/models/user.py", "User")).toBe("ent:src/models/user.py#User");
    expect(tableId("public", "users")).toBe("tbl:public.users");
    expect(packageId("@scope/pkg")).toBe("pkg:@scope/pkg");
  });

  it("normalizes windows separators and leading ./", () => {
    expect(fileId("src\\auth\\login.ts")).toBe("file:src/auth/login.ts");
    expect(fileId("./src/main.ts")).toBe("file:src/main.ts");
    expect(normalizePath("./a\\b")).toBe("a/b");
  });

  it("round-trips through parseNodeId", () => {
    const parsed = parseNodeId(symbolId("src/a.ts", "fn"));
    expect(parsed).toEqual({ kind: "sym", rest: "src/a.ts#fn", path: "src/a.ts", name: "fn" });

    const mod = parseNodeId(moduleId("auth"));
    expect(mod.kind).toBe("mod");
    expect(mod.rest).toBe("auth");
  });

  it("rejects malformed ids", () => {
    expect(() => parseNodeId("nope")).toThrow();
    expect(() => parseNodeId("sym:src/a.ts")).toThrow(); // missing '#'
    expect(isNodeId("file:src/a.ts")).toBe(true);
    expect(isNodeId("garbage")).toBe(false);
  });

  it("builds deterministic edge ids", () => {
    expect(edgeId("imports", "file:a.ts", "file:b.ts")).toBe("imports|file:a.ts|file:b.ts");
  });
});
