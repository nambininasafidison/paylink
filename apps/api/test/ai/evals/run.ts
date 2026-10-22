// SPDX-License-Identifier: MIT
/**
 * The eval runner (docs/paypal/SPEC.md §15.3, L4). Without `--live` it replays the scripted answers (what CI runs).
 * With `--live` it calls Workers AI through Cloudflare's REST API (`POST /client/v4/accounts/{account}/ai/run/{model}`,
 * cloudflare-docs `workers-ai/get-started/rest-api.mdx` at 3fe915d, with `options.rejectIfBusy` as in
 * `features/reject-if-busy.mdx`), the same models and requests as the Worker's binding, and writes a dated scoreboard
 * and the recorded cassette to apps/api/evals/results/.
 *
 *   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… \
 *     node --conditions=@paylink/source apps/api/test/ai/evals/run.ts --live --set all [--repeat 3] [--fallback]
 *
 * The token needs "Workers AI - Read" and "Workers AI - Edit" (rest-api.mdx); it is read from the environment only and
 * never written anywhere. A full run of the three sets costs about 4,000 neurons (E: 60 drafts and 16 desk runs), under
 * the 10,000 free a day; `--repeat 3` (pass^3) needs a second day or Workers Paid.
 *
 * Owner: AI workstream.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { withFallback } from "../../../src/ai/budget.ts";
import { FALLBACK_MODEL, PRIMARY_MODEL } from "../../../src/ai/models.ts";
import { recordingProvider } from "../../../src/ai/replay.ts";
import type { AiProvider } from "../../../src/ai/types.ts";
import { workersAiProvider } from "../../../src/ai/workers-ai.ts";
import type { A1Case, DeskCase, InjectionCase } from "./lib.ts";
import { EVALS_DIR, loadSet, referenceDeskModel, restBinding, runA1Case, runDeskCase, runInjectionCase, scoreA1, scriptedA1 } from "./lib.ts";

/** Counts what a provider's answers cost. */
function metered(inner: AiProvider): AiProvider & { readonly neurons: () => number; readonly models: () => Record<string, number> } {
  let neurons = 0;
  const models: Record<string, number> = {};
  const note = (r: { outcome: string; model?: string; usage?: { neurons: number | null } }): void => {
    if (r.outcome === "ok" && r.model !== undefined) {
      neurons += r.usage?.neurons ?? 0;
      models[r.model] = (models[r.model] ?? 0) + 1;
    }
  };
  return {
    ...inner,
    neurons: () => neurons,
    models: () => ({ ...models }),
    structured: async (request) => {
      const r = await inner.structured(request);
      note(r);
      return r;
    },
    toolTurn: async (request) => {
      const r = await inner.toolTurn(request);
      note(r);
      return r;
    },
  };
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { set: { type: "string", default: "all" }, live: { type: "boolean", default: false }, repeat: { type: "string", default: "1" }, fallback: { type: "boolean", default: false }, out: { type: "string", default: join(EVALS_DIR, "results") } } });
  const repeat = Math.max(1, Number(values.repeat));
  const sets = values.set === "all" ? ["a1", "desk", "injection"] : [values.set];
  let live: (AiProvider & { readonly neurons: () => number; readonly models: () => Record<string, number> }) | null = null;
  let recorder: ReturnType<typeof recordingProvider> | null = null;
  let label = "";
  if (values.live) {
    const accountId = process.env["CLOUDFLARE_ACCOUNT_ID"];
    const token = process.env["CLOUDFLARE_API_TOKEN"];
    if (accountId === undefined || token === undefined || accountId === "" || token === "") {
      throw new Error("set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI Read and Edit) for --live");
    }
    const binding = restBinding(accountId, token);
    const primary = workersAiProvider({ binding, model: PRIMARY_MODEL, timeoutMs: 30_000, clock: Date.now });
    const provider = values.fallback ? withFallback(primary, workersAiProvider({ binding, model: FALLBACK_MODEL, timeoutMs: 30_000, clock: Date.now })) : primary;
    recorder = recordingProvider(provider, () => label);
    live = metered(recorder);
  }
  const startedAt = new Date().toISOString();
  const scoreboard: Record<string, unknown> = { startedAt, mode: values.live ? "live" : "replay", model: values.live ? PRIMARY_MODEL.id : "scripted", fallback: values.fallback, repeat };
  for (const name of sets) {
    if (name === "a1") {
      const set = loadSet<A1Case>("a1");
      const now = Date.parse(set.now);
      const outcomes = [];
      for (const c of set.cases) {
        let last = null;
        let all = true;
        for (let k = 0; k < repeat; k += 1) {
          label = `a1:${c.id}:${String(k)}`;
          last = await runA1Case(c, live ?? (await scriptedA1(c, now)), now);
          all &&= last.pass;
        }
        if (last !== null) {
          outcomes.push({ ...last, pass: all });
        }
      }
      scoreboard["a1"] = { ...scoreA1(outcomes), floor: set.floor, bars: set["bars"] };
    } else if (name === "desk") {
      const set = loadSet<DeskCase>("desk");
      const results = [];
      for (const c of set.cases) {
        let all = true;
        let last = null;
        for (let k = 0; k < repeat; k += 1) {
          label = `desk:${c.id}:${String(k)}`;
          last = await runDeskCase(c, live ?? referenceDeskModel());
          all &&= last.pass;
        }
        results.push({ id: c.id, pass: all, proposed: last?.proposed, expected: last?.expected, messages: last?.messages, ending: last?.report?.ending });
      }
      const written = results.reduce((n, r) => n + (r.messages?.written ?? 0), 0);
      const kept = results.reduce((n, r) => n + (r.messages?.kept ?? 0), 0);
      scoreboard["desk"] = { cases: results.length, exactSet: results.filter((r) => r.pass).length / results.length, grounding: written === 0 ? 1 : kept / written, failed: results.filter((r) => !r.pass), floor: set.floor };
    } else if (name === "injection") {
      const set = loadSet<InjectionCase>("injection");
      const now = Date.parse(set.now);
      const failed = [];
      for (const c of set.cases) {
        label = `injection:${c.id}`;
        const outcome = await runInjectionCase(c, now, live);
        if (!outcome.pass) {
          failed.push(outcome);
        }
      }
      scoreboard["injection"] = { cases: set.cases.length, passed: set.cases.length - failed.length, failed, floor: set.floor };
    }
  }
  if (live !== null && recorder !== null) {
    scoreboard["neurons"] = live.neurons();
    scoreboard["answeredBy"] = live.models();
    mkdirSync(values.out, { recursive: true });
    const stamp = startedAt.replace(/[:.]/gu, "-");
    writeFileSync(join(values.out, `${stamp}.scoreboard.json`), `${JSON.stringify(scoreboard, null, 1)}\n`);
    writeFileSync(join(values.out, `${stamp}.cassette.json`), `${JSON.stringify(recorder.cassette(startedAt), null, 1)}\n`);
  }
  process.stdout.write(`${JSON.stringify(scoreboard, null, 1)}\n`);
}

await main();
