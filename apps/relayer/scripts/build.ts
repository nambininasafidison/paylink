// SPDX-License-Identifier: MIT
/**
 * Builds the deployable Worker (apps/relayer/deploy/).
 *
 * The Worker is deployed by Cloudflare's Git integration from `deploy/` (docs/runbooks/relayer.md), with
 * `no_bundle = true`: Cloudflare uploads the committed `worker.js` byte for byte, without installing this
 * workspace or running any build of ours. So the bundle is built here, from the lockfile's exact packages, and
 * committed; `--check` fails when it is stale, and its sha256 in SHA256SUMS is what the dashboard deploys.
 *
 * | Output              | Content                                                                                  |
 * |---------------------|------------------------------------------------------------------------------------------|
 * | deploy/worker.js    | ES module: header + rolldown bundle of src/worker/index.ts, not minified                 |
 * | deploy/LICENSES.txt | Licence of every third-party package that contributes code                              |
 * | deploy/SHA256SUMS   | sha256 of the two files above and of deploy/wrangler.toml (`sha256sum -c SHA256SUMS`)     |
 *
 * Every `//#region` names its source as `<package>@<version>/<path>` (third party) or its repository path (this
 * workspace), so a reviewer can diff the bundle against the published packages and the tree.
 *
 * Usage (from apps/relayer):  node --conditions=@paylink/source scripts/build.ts          rebuild and write
 *                             node --conditions=@paylink/source scripts/build.ts --check  exit 1 unless up to date
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { rolldown } from "rolldown";

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REPO_DIR = resolve(PACKAGE_DIR, "../..");
export const ENTRY = join(PACKAGE_DIR, "src/worker/index.ts");
export const REGISTRY_MODULE = join(PACKAGE_DIR, "src/worker/registry.ts");
export const DEPLOY_DIR = join(PACKAGE_DIR, "deploy");

/** Third-party packages allowed in the bundle, with the version pnpm-lock.yaml resolves. Anything else fails. */
export const EXPECTED_PACKAGES: Readonly<Record<string, string>> = {
  "@noble/curves": "1.9.1",
  "@noble/hashes": "1.8.0",
  abitype: "1.2.3",
  hono: "4.13.13",
  ox: "0.14.45",
  viem: "2.57.3",
  zod: "4.6.5",
};
const ALLOWED_LICENSES = new Set(["MIT"]);

export interface WorkerFiles {
  readonly "worker.js": string;
  readonly "LICENSES.txt": string;
  readonly SHA256SUMS: string;
}

interface BundledPackage {
  readonly name: string;
  readonly version: string;
  readonly license: string;
  readonly dir: string;
  modules: number;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The innermost `node_modules/<name>` (or `@scope/name`) directory of a module path, or `null` for workspace sources. */
function packageDirOf(modulePath: string): string | null {
  const marker = `${sep}node_modules${sep}`;
  const at = modulePath.lastIndexOf(marker);
  if (at === -1) {
    return null;
  }
  const rest = modulePath.slice(at + marker.length).split(sep);
  const name = rest[0]?.startsWith("@") === true ? `${rest[0]}${sep}${rest[1] ?? ""}` : (rest[0] ?? "");
  return modulePath.slice(0, at + marker.length) + name;
}

export interface BuildOptions {
  /** Bundle this module in place of src/worker/registry.ts (the workerd test suite; never for deploy/). */
  readonly registryModule?: string;
}

/** Bundles the Worker in memory. Deterministic: same lockfile and sources, same bytes. */
export async function buildWorker(options: BuildOptions = {}): Promise<WorkerFiles> {
  const override = options.registryModule;
  const bundle = await rolldown({
    input: ENTRY,
    cwd: PACKAGE_DIR,
    platform: "browser",
    treeshake: true,
    logLevel: "warn",
    // workerd provides `cloudflare:*`; nothing else may stay external.
    external: [/^cloudflare:/u],
    resolve: { conditionNames: ["@paylink/source", "workerd", "worker", "browser", "import", "default"] },
    plugins:
      override === undefined
        ? []
        : [
            {
              name: "test-registry",
              resolveId(source, importer) {
                return importer !== undefined && resolve(dirname(importer), source) === REGISTRY_MODULE ? override : null;
              },
            },
          ],
  });
  let code: string;
  let moduleIds: string[];
  try {
    const { output } = await bundle.generate({ format: "es", minify: false, codeSplitting: false });
    const [chunk, ...rest] = output;
    if (rest.length > 0) {
      throw new Error("expected exactly one output chunk");
    }
    code = chunk.code;
    moduleIds = Object.keys(chunk.modules);
  } finally {
    await bundle.close();
  }
  if (/\bfrom\s*["']node:|require\(["']node:/u.test(code)) {
    throw new Error("the Worker bundle imports a Node built-in: the core must stay isomorphic");
  }

  const packages = new Map<string, BundledPackage>();
  for (const id of moduleIds) {
    const dir = packageDirOf(resolve(PACKAGE_DIR, id));
    if (dir === null) {
      continue;
    }
    const known = packages.get(dir);
    if (known !== undefined) {
      known.modules += 1;
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
    if (!ALLOWED_LICENSES.has(p.license)) {
      throw new Error(`${p.name}@${p.version} is ${p.license}: review the licence before bundling it`);
    }
  }
  const names = new Set(list.map((p) => p.name));
  if (names.size !== list.length || names.size !== Object.keys(EXPECTED_PACKAGES).length) {
    throw new Error(`expected exactly ${Object.keys(EXPECTED_PACKAGES).join(", ")} once each, got ${list.map((p) => `${p.name}@${p.version}`).join(", ")}`);
  }

  // Region names independent of pnpm's store layout (peer-dependency suffixes change with the whole workspace).
  code = code.replace(/^\/\/#region (.+)$/gmu, (line, path: string) => {
    const absolute = resolve(PACKAGE_DIR, path);
    const dir = packageDirOf(absolute);
    if (dir === null) {
      return `//#region ${relative(REPO_DIR, absolute).split(sep).join("/")}`;
    }
    const owner = packages.get(dir);
    if (owner === undefined) {
      throw new Error(`region outside the bundled packages: ${path} (${line})`);
    }
    return `//#region ${owner.name}@${owner.version}/${relative(owner.dir, absolute).split(sep).join("/")}`;
  });

  const summary = list.map((p) => `${p.name}@${p.version}`).join(", ");
  const header = [
    "// SPDX-License-Identifier: MIT",
    "// PayLink relayer: Cloudflare Worker bundle. GENERATED, DO NOT EDIT.",
    `// Built by apps/relayer/scripts/build.ts from ${relative(REPO_DIR, ENTRY).split(sep).join("/")} with rolldown, not minified.`,
    override === undefined ? "// Registry: the shipped @paylink/chains registry (src/worker/registry.ts)." : "// Registry: TEST OVERRIDE. This bundle must never be deployed.",
    `// Third-party code: ${summary} (all MIT; texts in LICENSES.txt). Checksums: SHA256SUMS.`,
    "// Rebuild: pnpm --filter @paylink/relayer run build   Check: pnpm --filter @paylink/relayer run build:check",
    "",
  ].join("\n");
  const js = header + code;

  const licences = list
    .map((p) => {
      const text = readFileSync(join(p.dir, "LICENSE"), "utf8").trimEnd();
      return `${"=".repeat(78)}\n${p.name}@${p.version}  (${p.license}, ${String(p.modules)} modules)\nhttps://www.npmjs.com/package/${p.name}/v/${p.version}\n${"=".repeat(78)}\n\n${text}\n`;
    })
    .join("\n");
  const licencesTxt = `Third-party code in worker.js. Each package is used under the licence reproduced below.\nThe PayLink sources in the bundle (apps/relayer, packages/chains, packages/sdk) are MIT, see LICENSE at the repository root.\n\n${licences}`;
  const wrangler = readFileSync(join(DEPLOY_DIR, "wrangler.toml"), "utf8");
  const sums = [`${sha256(js)}  worker.js`, `${sha256(licencesTxt)}  LICENSES.txt`, `${sha256(wrangler)}  wrangler.toml`, ""].join("\n");
  return { "worker.js": js, "LICENSES.txt": licencesTxt, SHA256SUMS: sums };
}

/** Writes deploy/, or (with `check`) compares it with a rebuild. Returns the number of stale files. */
export async function build(check: boolean): Promise<number> {
  const files = await buildWorker();
  let stale = 0;
  for (const [name, content] of Object.entries(files) as [keyof WorkerFiles, string][]) {
    const path = join(DEPLOY_DIR, name);
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
      console.error(`stale: ${relative(REPO_DIR, path)} (run: pnpm --filter @paylink/relayer run build)`);
    } else {
      writeFileSync(path, content);
      console.log(`wrote ${relative(REPO_DIR, path)}`);
    }
  }
  return stale;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = (await build(process.argv.includes("--check"))) === 0 ? 0 : 1;
}
