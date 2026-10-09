// SPDX-License-Identifier: MIT
/**
 * The package contract with Envio Cloud (docs/runbooks/envio.md): the hosted builder detects the HyperIndex version
 * from this package.json (Root Directory apps/indexer) and may install the package on its own, outside the pnpm
 * workspace. So every dependency is an exact version (no "catalog:" or "workspace:" specifier), the same versions the
 * workspace catalog pins, and tsconfig.json stands alone with the base file's compiler options.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("../../../", import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), "utf8");

interface PackageJson {
  readonly type?: string;
  readonly engines?: Record<string, string>;
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}
const pkg = JSON.parse(read("apps/indexer/package.json")) as PackageJson;

/** The `catalog:` block of pnpm-workspace.yaml: `  name: version # comment` lines. */
function catalog(): Map<string, string> {
  const yaml = read("pnpm-workspace.yaml");
  const block = /^catalog:\n((?: {2}.*\n|\s*\n)+)/m.exec(yaml)?.[1] ?? "";
  const pins = new Map<string, string>();
  for (const match of block.matchAll(/^ {2}'?([^':\s]+)'?: ([^\s#]+)/gm)) {
    pins.set(match[1] ?? "", match[2] ?? "");
  }
  return pins;
}

describe("package.json", () => {
  it("is an ES module package with envio as a production dependency (Envio Cloud version detection)", () => {
    expect(pkg.type).toBe("module");
    expect(pkg.dependencies).toEqual({ envio: "3.12.1" });
  });

  it("pins exact versions only, equal to the workspace catalog", () => {
    const pins = catalog();
    expect(pins.get("envio")).toBe("3.12.1");
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    for (const [name, version] of Object.entries(all)) {
      expect(version, name).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
      expect(pins.get(name), `${name} must be in the pnpm-workspace.yaml catalog`).toBe(version);
    }
  });
});

describe("tsconfig.json", () => {
  it("repeats every compiler option of tsconfig.base.json that applies to type-checking", () => {
    const base = (JSON.parse(read("tsconfig.base.json")) as { compilerOptions: Record<string, unknown> }).compilerOptions;
    const own = JSON.parse(read("apps/indexer/tsconfig.json")) as { extends?: string; compilerOptions: Record<string, unknown> };
    expect(own.extends).toBeUndefined();
    // Emit-only options are irrelevant with noEmit; customConditions only serves workspace sources, never imported here.
    const skip = new Set(["declaration", "declarationMap", "sourceMap", "customConditions", "types"]);
    for (const [option, value] of Object.entries(base)) {
      if (!skip.has(option)) {
        expect(own.compilerOptions[option], option).toEqual(value);
      }
    }
  });
});
