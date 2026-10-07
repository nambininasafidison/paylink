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

/** Writes the files, or (with `check`) compares them with the committed ones. Returns the number of stale files. */
export async function vendor(check: boolean): Promise<number> {
  const files = await buildVendor();
  let stale = 0;
  for (const [name, content] of Object.entries(files) as [keyof VendorFiles, string][]) {
    const path = join(VENDOR_DIR, name);
    let current: string;
    try {
      current = readFileSync(path, "utf8");
    } catch {
      current = "";
    }
    if (current === content) {
      continue;
    }
    if (check) {
      stale += 1;
      console.error(`stale: ${relative(REPO_DIR, path)} (run: pnpm --filter @paylink/deploy-page run vendor)`);
    } else {
      writeFileSync(path, content);
      console.log(`wrote ${relative(REPO_DIR, path)}`);
    }
  }
  return stale;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = (await vendor(process.argv.includes("--check"))) === 0 ? 0 : 1;
}
