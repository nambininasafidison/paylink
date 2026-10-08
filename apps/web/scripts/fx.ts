// SPDX-License-Identifier: MIT
/**
 * Refreshes `public/fx.json`, the display-only exchange-rate snapshot behind the "≈ … Ar · estimate · rate of <date>"
 * label (PAYLINK-V2-SPEC §3.8 item 4). Never used in any amount calculation; the app reads it same-origin and shows its
 * source and date next to every estimate.
 *
 * Source: fawazahmed0/exchange-api (CC0-1.0, keyless), as published to the npm registry under
 * `@fawazahmed0/currency-api` (one version per day). The registry is reached over HTTPS and the tarball's integrity is
 * checked against the registry's `dist.integrity` (SHA-512) before anything is read from it.
 *
 * Usage (from apps/web):  node scripts/fx.ts            write public/fx.json from the latest published day
 *                         node scripts/fx.ts --check    exit 1 when public/fx.json is malformed (offline)
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

const PUBLIC = fileURLToPath(new URL("../public/", import.meta.url));
const PACKAGE = "@fawazahmed0/currency-api";
const ENTRY = "package/v1/currencies/usd.json";
/** Currencies the app shows, quoted per US dollar. */
const CODES = ["MGA", "EUR"] as const;

export interface FxSnapshot {
  readonly version: 1;
  readonly base: "USD";
  /** The rates' day (UTC), as published. */
  readonly date: string;
  /** Units of each currency per US dollar, as decimal strings (display only). */
  readonly rates: Readonly<Record<(typeof CODES)[number], string>>;
  readonly source: { readonly name: string; readonly url: string; readonly package: string; readonly license: "CC0-1.0" };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RATE = /^(0|[1-9]\d{0,9})(\.\d{1,12})?$/;

/** Validates a snapshot (the app applies the same rules when it reads one). */
export function checkSnapshot(value: unknown): FxSnapshot {
  const v = value as Partial<FxSnapshot> | null;
  if (v?.version !== 1 || v.base !== "USD" || typeof v.date !== "string" || !DATE.test(v.date) || typeof v.rates !== "object") {
    throw new Error("fx.json: bad header");
  }
  for (const code of CODES) {
    const rate = v.rates[code];
    if (typeof rate !== "string" || !RATE.test(rate) || Number(rate) <= 0) {
      throw new Error(`fx.json: bad rate ${code}`);
    }
  }
  if (v.source?.license !== "CC0-1.0") {
    throw new Error("fx.json: bad source");
  }
  return v as FxSnapshot;
}

/** Reads one file out of a (gunzipped) ustar archive. */
export function untarFile(tar: Buffer, wanted: string): Buffer {
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) {
      break;
    }
    const name = header.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/s, "");
    const size = Number.parseInt(header.subarray(124, 136).toString("utf8").replace(/\0.*$/s, "").trim() || "0", 8);
    const path = prefix === "" ? name : `${prefix}/${name}`;
    const body = offset + 512;
    if (path === wanted) {
      return tar.subarray(body, body + size);
    }
    offset = body + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${wanted} not in the archive`);
}

async function main(argv: readonly string[]): Promise<void> {
  const target = join(PUBLIC, "fx.json");
  if (argv.includes("--check")) {
    checkSnapshot(JSON.parse(readFileSync(target, "utf8")));
    return;
  }
  const meta = (await (await fetch(`https://registry.npmjs.org/${PACKAGE}/latest`)).json()) as { version: string; dist: { tarball: string; integrity: string } };
  if (!/^\d{4}\.\d{1,2}\.\d{1,2}$/.test(meta.version) || !meta.dist.tarball.startsWith("https://registry.npmjs.org/") || !meta.dist.integrity.startsWith("sha512-")) {
    throw new Error("unexpected registry metadata");
  }
  const tarball = Buffer.from(await (await fetch(meta.dist.tarball)).arrayBuffer());
  const digest = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;
  if (digest !== meta.dist.integrity) {
    throw new Error("tarball integrity mismatch");
  }
  const usd = JSON.parse(untarFile(gunzipSync(tarball), ENTRY).toString("utf8")) as { date: string; usd: Record<string, number> };
  const rates = Object.fromEntries(
    CODES.map((code) => {
      const rate = usd.usd[code.toLowerCase()];
      if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0) {
        throw new Error(`no ${code} rate`);
      }
      return [code, rate.toFixed(8).replace(/0+$/, "").replace(/\.$/, "")];
    }),
  ) as FxSnapshot["rates"];
  const snapshot = checkSnapshot({
    version: 1,
    base: "USD",
    date: usd.date,
    rates,
    source: { name: "fawazahmed0/exchange-api", url: "https://github.com/fawazahmed0/exchange-api", package: `${PACKAGE}@${meta.version}`, license: "CC0-1.0" },
  });
  writeFileSync(target, `${JSON.stringify(snapshot, null, 2)}\n`);
  console.log(`wrote public/fx.json: 1 USD = ${snapshot.rates.MGA} MGA (${snapshot.date})`);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  await main(process.argv.slice(2));
}
