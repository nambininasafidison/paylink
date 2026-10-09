// SPDX-License-Identifier: MIT
/**
 * `/status/`: every light checked live (spec §3.6). Per chain of the edition: whether the registry's RPCs answer, and
 * whether the registry's deployment is the genuine release (masked runtime hash, the seven EIP-712 immutables for
 * that chain and address, ERC-5267 domain; `verifyDeploymentCode`). Then the services from `/config.json` (relayer and
 * history indexer, each optional) and this build: version, commit, configuration, device storage, offline mode.
 */
import type { ChainDefinition } from "@paylink/chains";
import { RELEASE } from "@paylink/chains";
import { featureTranslator } from "@paylink/i18n";
import { verifyDeploymentCode } from "@paylink/sdk";
import type { PageDefinition } from "../app/boot.ts";
import { networkName } from "../app/chains.ts";
import type { App } from "../app/context.ts";
import { intro, notes } from "../app/shell.ts";
import { indexerFor } from "../read/indexer.ts";
import { hexGroups } from "../ui/atoms.ts";
import { h } from "../ui/h.ts";

declare const __PAYLINK_BUILD__: { readonly version: string; readonly commit: string; readonly builtAt: string };

type Light = "ok" | "wait" | "err" | "busy" | "off";

function light(name: string): { element: HTMLLIElement; set(state: Light, detail: string): void } {
  const detail = h("span", { class: "vstrip-detail" });
  const element = h("li", { attrs: { "data-lamp": "busy" } }, h("span", { class: "vstrip-name" }, name), detail);
  return {
    element,
    set(state, text) {
      element.setAttribute("data-lamp", state === "off" ? "" : state);
      detail.textContent = text;
    },
  };
}

export const statusPage: PageDefinition = {
  route: "status",
  payer: false,
  title: "status.docTitle",
  render(app, ui) {
    const { t } = app.i18n;
    ui.intro.append(intro({ kicker: t("status.kicker"), title: [t("status.h1a"), t("status.h1b")], lede: t("status.lede") }));
    ui.aside.append(
      notes(t("status.notes.title"), [
        [t("status.notes.release"), t("status.notes.releaseText", { initCodeHash: `${RELEASE.initCodeHash.slice(0, 10)}…${RELEASE.initCodeHash.slice(-4)}` })],
        [t("status.notes.address"), t("status.notes.addressText", { address: RELEASE.create2.address })],
      ]),
    );
    ui.plate(t("status.plate"), "wait");
    const board = h("ul", { class: "board" });
    const results: Promise<boolean>[] = [];
    for (const chain of app.registry.chains) {
      const rpc = light(t("status.rpc"));
      const code = light(t("status.code"));
      const target = app.registry.v2Target(chain.chainId);
      board.append(
        h(
          "li",
          null,
          h("div", { class: "board-head" }, h("span", { class: "board-name" }, chain.label), h("span", { class: "board-sub" }, `${networkName(chain)} · ${String(chain.chainId)}`)),
          target === undefined ? null : h("p", { class: "board-sub" }, hexGroups(target.deployment.address)),
          h("ul", { class: "vstrip" }, rpc.element, code.element),
        ),
      );
      results.push(checkChain(app, chain, rpc, code));
    }
    const relayer = light(t("status.relayer"));
    const indexer = light(t("status.indexer"));
    const build = light(t("status.build"));
    const config = light(t("status.config"));
    const storage = light(t("status.storage"));
    const offline = light(t("status.offline"));
    build.set("ok", t("status.buildValue", { version: __PAYLINK_BUILD__.version, commit: __PAYLINK_BUILD__.commit.slice(0, 7), edition: app.edition.id }));
    if (app.configProblem === null) {
      config.set("ok", t("status.config.ok"));
    } else {
      config.set("err", t("status.config.err", { problem: app.configProblem }));
    }
    storage.set(app.store.persistent ? "ok" : "wait", app.store.persistent ? t("status.storage.ok") : t("status.storage.memory"));
    void service(app, app.config.relayer === null ? null : app.config.relayer.url, relayer, "/v1/health", t("status.relayer.none"));
    void indexerHealth(app, indexer);
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.getRegistration(app.site.base).then((registration) => {
        const active = registration?.active ?? null;
        offline.set(active === null ? "off" : "ok", active === null ? t("status.offline.none") : t("status.offline.ok"));
      });
    } else {
      offline.set("off", t("status.offline.none"));
    }
    void Promise.all(results).then((oks) => {
      ui.plate(t("status.plate"), oks.every(Boolean) ? "ok" : "wait");
    });
    ui.views.append(
      h(
        "section",
        { class: "view view-status", attrs: { "aria-labelledby": "status-head" } },
        h("div", { class: "view-head" }, h("h2", { attrs: { id: "status-head" } }, t("status.head")), h("span", { class: "view-meta" }, t("status.release", { release: RELEASE.release }))),
        board,
        h("div", { class: "sub-head" }, h("h3", null, t("status.services"))),
        h("ul", { class: "vstrip" }, relayer.element, indexer.element),
        h("div", { class: "sub-head" }, h("h3", null, t("status.app"))),
        h("ul", { class: "vstrip" }, build.element, config.element, storage.element, offline.element),
        h("div", { class: "key-row" }, h("a", { class: "key key-line", attrs: { href: "/deploy/" } }, t("status.deployLink")), h("a", { class: "key key-line", attrs: { href: "/arc/" } }, t("status.arcLink"))),
      ),
    );
  },
};

async function checkChain(app: App, chain: ChainDefinition, rpc: ReturnType<typeof light>, code: ReturnType<typeof light>): Promise<boolean> {
  const { t } = app.i18n;
  const client = app.client(chain);
  const target = app.registry.v2Target(chain.chainId);
  const started = performance.now();
  try {
    const block = await client.getBlockNumber();
    rpc.set("ok", t("status.rpc.ok", { block: block.toString(), ms: Math.round(performance.now() - started) }));
  } catch {
    rpc.set("err", t("status.rpc.err"));
    code.set("wait", t("status.code.unknown"));
    return false;
  }
  if (target === undefined) {
    code.set("off", t("status.code.none"));
    return true;
  }
  try {
    const result = await verifyDeploymentCode({ client, chainId: chain.chainId, address: target.deployment.address });
    if (result.genuine) {
      code.set("ok", t("status.code.ok", { release: target.deployment.release }));
      return true;
    }
    code.set("err", t(`status.code.${result.failure === "no-code" ? "noCode" : result.failure === "masked-hash" ? "maskedHash" : result.failure}`));
    return false;
  } catch {
    code.set("wait", t("status.code.unknown"));
    return false;
  }
}

/**
 * The history service answers its GraphQL endpoint with the block it has processed on each of the edition's chains
 * (Envio's `_meta`): green when every chain is caught up, amber while one is still catching up or is not indexed.
 */
async function indexerHealth(app: App, item: ReturnType<typeof light>): Promise<void> {
  const { t } = app.i18n;
  const client = indexerFor(app.config);
  if (client === null) {
    item.set("off", t("status.indexer.none"));
    return;
  }
  try {
    // The per-chain words are in the `history` feature catalogue, loaded with the answer.
    const [progress, history] = await Promise.all([client.progress(), featureTranslator(app.locale, "history")]);
    const chains = app.registry.chains.filter((chain) => app.registry.v2Target(chain.chainId) !== undefined && client.serves(chain.chainId));
    const lines = chains.map((chain) => {
      const row = progress.find((p) => p.chainId === chain.chainId);
      const network = networkName(chain);
      return row === undefined
        ? { ready: false, text: history.t("history.status.missing", { network }) }
        : { ready: row.ready, text: history.t(row.ready ? "history.status.progress" : "history.status.syncing", { network, block: row.progressBlock.toString() }) };
    });
    item.set(lines.length > 0 && lines.every((l) => l.ready) ? "ok" : "wait", lines.length === 0 ? history.t("history.status.noChain") : lines.map((l) => l.text).join(" · "));
  } catch {
    item.set("err", t("status.service.down"));
  }
}

/** A configured service answers its health path with HTTP 2xx (the relayer's `GET /v1/health`). */
async function service(app: App, url: string | null, item: ReturnType<typeof light>, path: string, none: string): Promise<void> {
  const { t } = app.i18n;
  if (url === null) {
    item.set("off", none);
    return;
  }
  try {
    const response = await fetch(`${url.replace(/\/$/, "")}${path}`, { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer", signal: AbortSignal.timeout(8000) });
    const body = (await response.json().catch(() => null)) as { status?: unknown; version?: unknown } | null;
    const version = typeof body?.version === "string" ? body.version.slice(0, 32) : "";
    if (response.ok) {
      item.set(body?.status === "degraded" ? "wait" : "ok", t("status.service.ok", { version }));
    } else {
      item.set("err", t("status.service.down"));
    }
  } catch {
    item.set("err", t("status.service.down"));
  }
}
