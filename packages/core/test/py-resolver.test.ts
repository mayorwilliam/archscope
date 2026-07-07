import { describe, expect, it } from "vitest";
import type { ImportFact } from "../src/parse/facts.js";
import { PyResolver } from "../src/resolve/py-resolver.js";
import type { ResolvedImport } from "../src/resolve/resolver.js";
import { fixturePath } from "./helpers.js";

/**
 * Table-driven Python resolver cases, same maintenance contract as the TS
 * table: every mis-resolution bug report becomes one new row here.
 */

interface Case {
  importer: string;
  specifier: string;
  symbols: string[];
  expected: ResolvedImport[];
}

function imp(specifier: string, symbols: string[]): ImportFact {
  return { specifier, symbols, kind: "static", line: 1 };
}

describe("PyResolver on py-basic (src layout, auto roots)", () => {
  const resolver = new PyResolver(fixturePath("py-basic"), { version: 1 });

  const cases: Case[] = [
    {
      // absolute dotted path through the src/ root, down to a module file
      importer: "main.py",
      specifier: "app.api.handlers",
      symbols: ["handle_request"],
      expected: [
        {
          resolution: { type: "file", relPath: "src/app/api/handlers.py" },
          symbols: ["handle_request"],
        },
      ],
    },
    {
      // stdlib, classified after local roots miss
      importer: "main.py",
      specifier: "json",
      symbols: [],
      expected: [{ resolution: { type: "builtin", name: "json" }, symbols: [] }],
    },
    {
      // `from . import handlers` — the name is a submodule, not an attribute
      importer: "src/app/api/__init__.py",
      specifier: ".",
      symbols: ["handlers"],
      expected: [{ resolution: { type: "file", relPath: "src/app/api/handlers.py" }, symbols: [] }],
    },
    {
      // two-dot relative into a sibling package's module
      importer: "src/app/api/handlers.py",
      specifier: "..models.user",
      symbols: ["User"],
      expected: [
        { resolution: { type: "file", relPath: "src/app/models/user.py" }, symbols: ["User"] },
      ],
    },
    {
      // `from ..db import client` — target is a package; client is a submodule
      importer: "src/app/api/handlers.py",
      specifier: "..db",
      symbols: ["client"],
      expected: [{ resolution: { type: "file", relPath: "src/app/db/client.py" }, symbols: [] }],
    },
    {
      // external package → PyPI
      importer: "src/app/api/handlers.py",
      specifier: "requests",
      symbols: [],
      expected: [
        { resolution: { type: "package", name: "requests", registry: "pypi" }, symbols: [] },
      ],
    },
    {
      // one-dot relative to a plain module file (attribute import)
      importer: "src/app/models/user.py",
      specifier: "..config",
      symbols: ["settings"],
      expected: [
        { resolution: { type: "file", relPath: "src/app/config.py" }, symbols: ["settings"] },
      ],
    },
    {
      // dynamic importlib.import_module("app.plugins") — absolute, no symbols
      importer: "src/app/db/client.py",
      specifier: "app.plugins",
      symbols: [],
      expected: [{ resolution: { type: "file", relPath: "src/app/plugins.py" }, symbols: [] }],
    },
    {
      // `from .models import User` where models is a package and User is an
      // attribute of its __init__ — falls back to the __init__.py edge
      importer: "src/app/config.py",
      specifier: ".models",
      symbols: ["User"],
      expected: [
        {
          resolution: { type: "file", relPath: "src/app/models/__init__.py" },
          symbols: ["User"],
        },
      ],
    },
    {
      // relative miss → unresolved, never a guess
      importer: "src/app/api/__init__.py",
      specifier: ".missing",
      symbols: ["x"],
      expected: [{ resolution: { type: "unresolved" }, symbols: ["x"] }],
    },
    {
      // the top-level package exists locally but the subpath doesn't:
      // an internal miss, NOT an external PyPI dependency
      importer: "main.py",
      specifier: "app.nonexistent",
      symbols: ["x"],
      expected: [{ resolution: { type: "unresolved" }, symbols: ["x"] }],
    },
    {
      // climbing past the repo root → unresolved
      importer: "main.py",
      specifier: "..outside",
      symbols: ["x"],
      expected: [{ resolution: { type: "unresolved" }, symbols: ["x"] }],
    },
  ];

  it.each(cases)("$importer → $specifier", ({ importer, specifier, symbols, expected }) => {
    expect(resolver.resolveImport(importer, imp(specifier, symbols))).toEqual(expected);
  });
});
