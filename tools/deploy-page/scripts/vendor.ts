// SPDX-License-Identifier: MIT
/**
 * Vendors the deploy page's viem subset (web/v2/deploy/vendor/).
 *
 * The page has no build step (Cloudflare Pages serves `web/` as is), so the few viem functions it needs are bundled
 * once, here, from the exact viem in pnpm-lock.yaml, and committed. The bundle is **not minified**: every
 * `//#region` names the upstream file it comes from, so a reviewer can diff it against the published package.
 *
 * | Output                              | Content                                                              |
 * |-------------------------------------|----------------------------------------------------------------------|
 * | web/v2/deploy/vendor/viem.js        | ES module: header + rolldown bundle of src/viem-subset.js             |
 * | web/v2/deploy/vendor/viem.d.ts      | Type surface for `tsc --checkJs` (re-exports viem's own declarations) |
 * | web/v2/deploy/vendor/LICENSES.txt   | Licence of every package that contributes code to the bundle          |
 * | web/v2/deploy/vendor/SHA256SUMS     | sha256 of the three files above (`sha256sum -c SHA256SUMS`)           |
 *
 * Usage (from tools/deploy-page):  node scripts/vendor.ts          rebuild and write
 *                                  node scripts/vendor.ts --check  exit 1 unless the committed files equal a rebuild
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = resolve(PACKAGE_DIR, "../..");
export const ENTRY = join(PACKAGE_DIR, "src/viem-subset.js");
export const VENDOR_DIR = join(REPO_DIR, "web/v2/deploy/vendor");

/** The packages allowed to contribute code, with the version pnpm-lock.yaml resolves. Anything else fails the build. */
export const EXPECTED_PACKAGES: Readonly<Record<string, string>> = {
  viem: "2.57.3",
  abitype: "1.2.3",
  "@noble/hashes": "1.8.0",
};

export interface VendorFiles {
  readonly "viem.js": string;
  readonly "viem.d.ts": string;
  readonly "LICENSES.txt": string;
  readonly SHA256SUMS: string;
}

interface BundledPackage {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly dir: string;
  readonly modules: number;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The package that owns a bundled module: the innermost `node_modules/<name>` (or `node_modules/@scope/name`) in its path. */
function packageDirOf(modulePath: string): string {
  const marker = "/node_modules/";
  const at = modulePath.lastIndexOf(marker);
  if (at === -1) {
    throw new Error(`bundled module outside node_modules: ${modulePath}`);
  }
  const rest = modulePath.slice(at + marker.length).split("/");
  const name = rest[0]?.startsWith("@") === true ? `${rest[0]}/${rest[1] ?? ""}` : (rest[0] ?? "");
  return modulePath.slice(0, at + marker.length) + name;
}

/** Rebuilds every vendored file in memory. Deterministic: same lockfile, same bytes. */
export async function buildVendor(): Promise<VendorFiles> {
  const bundle = await rolldown({ input: ENTRY, platform: "browser", treeshake: true, logLevel: "warn", cwd: PACKAGE_DIR });
  let code: string;
  let moduleIds: string[];
  try {
    const { output } = await bundle.generate({ format: "es", minify: false });
    const [chunk, ...rest] = output;
    if (rest.length > 0) {
      throw new Error("expected exactly one output chunk");
    }
    code = chunk.code;
    moduleIds = Object.keys(chunk.modules).filter((id) => resolve(id) !== ENTRY);
  } finally {
    await bundle.close();
  }

  const packages = new Map<string, BundledPackage>();
  for (const id of moduleIds) {
    const dir = packageDirOf(resolve(PACKAGE_DIR, id));
    const known = packages.get(dir);
    if (known !== undefined) {
      packages.set(dir, { ...known, modules: known.modules + 1 });
      continue;
    }
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name: string; version: string; license: string };
    packages.set(dir, { name: manifest.name, version: manifest.version, license: manifest.license, dir, modules: 1 });
  }
  const list = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
  for (const p of list) {
    if (EXPECTED_PACKAGES[p.name] !== p.version) {
      throw new Error(`unexpected package in the bundle: ${p.name}@${p.version} (allowed: ${JSON.stringify(EXPECTED_PACKAGES)})`);
    }
    if (p.license !== "MIT") {
      throw new Error(`${p.name}@${p.version} is ${p.license}, not MIT: review the licence before vendoring it`);
    }
  }
  if (list.length !== Object.keys(EXPECTED_PACKAGES).length) {
    throw new Error(`expected ${Object.keys(EXPECTED_PACKAGES).join(", ")} in the bundle, got ${list.map((p) => p.name).join(", ")}`);
  }

  // rolldown names each region by its path in the pnpm store, whose directory names carry the peer-dependency
  // suffix of the whole workspace (`viem@2.57.3_..._zod@4.6.5`): an unrelated workspace package adding a peer would
  // change the bundle. A rebuild names each region `<package>@<version>/<path in the package>` instead: stable, and
  // exactly what a reviewer diffs against the published tarball. The committed bundle may still carry store paths
  // (it is served as is and stays byte-identical); `canonicalRegions` maps them for the comparison.
  code = code.replace(/^\/\/#region (.+)$/gmu, (line, path: string) => {
    const absolute = resolve(PACKAGE_DIR, path);
    const owner = packages.get(packageDirOf(absolute));
    if (owner === undefined) {
      throw new Error(`region outside the bundled packages: ${path} (${line})`);
    }
    return `//#region ${owner.name}@${owner.version}/${relative(owner.dir, absolute)}`;
  });

  const summary = list.map((p) => `${p.name}@${p.version} (${p.license}, ${p.modules} modules)`).join(", ");
  const header = [
    "// SPDX-License-Identifier: MIT",
    "// Vendored viem subset for the PayLink deploy page. GENERATED, DO NOT EDIT.",
    `// Built by tools/deploy-page/scripts/vendor.ts from ${relative(REPO_DIR, ENTRY)} with rolldown, not minified.`,
    `// Contains: ${summary}. Licences: LICENSES.txt. Checksums: SHA256SUMS.`,
    "// Rebuild: pnpm --filter @paylink/deploy-page run vendor   Check: pnpm --filter @paylink/deploy-page run vendor:check",
    "",
  ].join("\n");
  const js = header + code;

  const entryText = readFileSync(ENTRY, "utf8");
  const exportsBlock = /export \{[\s\S]*?\} from "viem";/.exec(entryText)?.[0];
  if (exportsBlock === undefined) {
    throw new Error("src/viem-subset.js must hold one `export { ... } from \"viem\";` block");
  }
  const dts = [
    "// SPDX-License-Identifier: MIT",
    "// Type surface of viem.js for `tsc --checkJs` (tools/deploy-page/tsconfig.web.json maps \"viem\" to the pinned package).",
    "// GENERATED by tools/deploy-page/scripts/vendor.ts, DO NOT EDIT.",
    exportsBlock,
    "",
  ].join("\n");

  const licences = list
    .map((p) => {
      const text = readFileSync(join(p.dir, "LICENSE"), "utf8").trimEnd();
      return `${"=".repeat(78)}\n${p.name}@${p.version}  (${p.license})\nhttps://www.npmjs.com/package/${p.name}/v/${p.version}\n${"=".repeat(78)}\n\n${text}\n`;
    })
    .join("\n");
  const licencesTxt = `Third-party code in viem.js. Each package is used under the licence reproduced below.\n\n${licences}`;

  const sums = [
    `${sha256(js)}  viem.js`,
    `${sha256(dts)}  viem.d.ts`,
    `${sha256(licencesTxt)}  LICENSES.txt`,
    "",
  ].join("\n");
  return { "viem.js": js, "viem.d.ts": dts, "LICENSES.txt": licencesTxt, SHA256SUMS: sums };
}

/**
 * Maps every `//#region` comment that names a module by its pnpm store path
 * (`../../node_modules/.pnpm/<dir>/node_modules/<package>/<path>`) to `<package>@<version>/<path>`, the form a rebuild
 * writes. The version comes from the store directory (`<package with + for />@<version>[_<peers>]`). Code is untouched.
 */
export function canonicalRegions(code: string): string {
  return code.replace(/^\/\/#region (?:\.\.\/)*node_modules\/\.pnpm\/([^/]+)\/node_modules\/((?:@[^/]+\/)?[^/]+)\/(.+)$/gmu, (line, dir: string, name: string, path: string) => {
    const prefix = `${name.replace("/", "+")}@`;
    if (!dir.startsWith(prefix)) {
      throw new Error(`region path does not match its store directory: ${line}`);
    }
    const version = dir.slice(prefix.length).split("_")[0] ?? "";
    return `//#region ${name}@${version}/${path}`;
  });
}

/**
 * What the vendored files must be, given the committed ones: a rebuild, except that a committed `viem.js` whose code
 * equals the rebuild once its region comments are canonical (`canonicalRegions`) keeps its bytes, and SHA256SUMS then
 * lists those bytes.
 */
export function expectedFiles(fresh: VendorFiles, read: (name: keyof VendorFiles) => string): VendorFiles {
  const committedJs = read("viem.js");
  if (committedJs === fresh["viem.js"] || canonicalRegions(committedJs) !== fresh["viem.js"]) {
    return fresh;
  }
  return { ...fresh, "viem.js": committedJs, SHA256SUMS: fresh.SHA256SUMS.replace(/^[0-9a-f]{64}(?= {2}viem\.js$)/mu, sha256(committedJs)) };
}

/** Names of the committed files that differ from `expectedFiles`. */
export function staleFiles(fresh: VendorFiles, read: (name: keyof VendorFiles) => string): (keyof VendorFiles)[] {
  const expected = expectedFiles(fresh, read);
  return (Object.keys(expected) as (keyof VendorFiles)[]).filter((name) => read(name) !== expected[name]);
}

/** Writes the files, or (with `check`) compares them with the committed ones. Returns the number of stale files. */
export async function vendor(check: boolean): Promise<number> {
  const read = (name: keyof VendorFiles): string => {
    try {
      return readFileSync(join(VENDOR_DIR, name), "utf8");
    } catch {
      return "";
    }
  };
  const expected = expectedFiles(await buildVendor(), read);
  const stale = staleFiles(expected, read);
  for (const name of stale) {
    const path = join(VENDOR_DIR, name);
    if (check) {
      console.error(`stale: ${relative(REPO_DIR, path)} (run: pnpm --filter @paylink/deploy-page run vendor)`);
    } else {
      writeFileSync(path, expected[name]);
      console.log(`wrote ${relative(REPO_DIR, path)}`);
    }
  }
  return stale.length;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = (await vendor(process.argv.includes("--check"))) === 0 ? 0 : 1;
}
