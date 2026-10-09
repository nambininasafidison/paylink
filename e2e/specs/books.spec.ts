// SPDX-License-Identifier: MIT
/**
 * The ledger backup end to end (ADR 0016, PAYLINK-V2-SPEC §2.1 T2: "One passkey, many keys"), on the Monad edition's
 * production build under its real headers, anvil as Monad testnet, and Chromium's WebAuthn virtual authenticator with
 * PRF.
 *
 * - Device A (the merchant's phone): a PayLink key (Mera, account namespace), two invoices with memos, then "Back up my
 *   ledger": one fingerprint for the second namespace, `paylink.books.v1`, and a file that names the account and the
 *   network in clear and holds the memos only encrypted.
 * - The test asks A's authenticator itself for both PRF outputs and checks, with node:crypto, that the file opens with
 *   the books namespace's key (HKDF-SHA-256 → AES-256-GCM) and not with the account's: the second namespace really does
 *   the work. Neither output, nor the AES key, is anywhere in either device's storage.
 * - Device B (a second browser profile, empty): the same passkey, reached through the cross-device bridge
 *   (`fixtures/hybrid.ts`), signs in to the same account, restores the file and sees the two invoices with their memos.
 *   An altered copy is refused ("integrity check", BooksTampered) and restores nothing.
 * - Device C (another passkey): A's file is refused before any prompt (BooksOtherAccount); the same file with its
 *   merchant edited to C's account asks C's fingerprint and stays locked (BooksWrongKey).
 * - The panel on a 390 px phone, dark: axe-core zero violations, no sideways scroll.
 */
import { createDecipheriv, hkdfSync, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import type { Address } from "viem";
import { axe } from "../fixtures/axe.ts";
import { addAuthenticator, BASE, buildEditionsSite, MONAD, routeRelayer, startEditionChains, startRelayer } from "../fixtures/editions.ts";
import type { EditionChains, LocalRelayer } from "../fixtures/editions.ts";
import { bridgePasskey, prfOf } from "../fixtures/hybrid.ts";
import { horizontalOverflow } from "../fixtures/layout.ts";
import { servePages } from "../fixtures/pages.ts";
import type { StaticServer } from "../fixtures/pages.ts";
import { routeRegistry } from "../fixtures/wallet.ts";

let chains: EditionChains;
let server: StaticServer;
let relayer: LocalRelayer;
/** WebAuthn needs a domain, not an IP address. */
let origin: string;
const contexts: BrowserContext[] = [];

test.beforeAll(async () => {
  chains = await startEditionChains();
  server = await servePages(await buildEditionsSite());
  origin = server.origin.replace("127.0.0.1", "localhost");
  relayer = await startRelayer(chains, origin);
});

test.afterAll(async () => {
  for (const context of contexts) {
    await context.close();
  }
  await relayer.stop();
  await server.close();
  await chains.monad.anvil.stop();
  await chains.base.anvil.stop();
});

interface Device {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly problems: string[];
}

async function device(browser: Browser, options: { readonly phone?: boolean; readonly scheme?: "light" | "dark" } = {}): Promise<Device> {
  const context = await browser.newContext({
    viewport: options.phone === true ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    ...(options.phone === true ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}),
    colorScheme: options.scheme ?? "light",
    acceptDownloads: true,
  });
  contexts.push(context);
  await routeRegistry(context, new Map([[MONAD, chains.monad.anvil.url], [BASE, chains.base.anvil.url]]));
  await routeRelayer(context, relayer);
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("ERR_CONNECTION_REFUSED")) {
      problems.push(message.text());
    }
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  return { context, page, problems };
}

/** The KeyCard is open: create a PayLink key, or use the one the passkey manager offers. */
async function keyCard(page: Page, action: "create" | "use", name = "Rakoto Design"): Promise<Address> {
  const dialog = page.locator("dialog.modal-key");
  await expect(dialog).toBeVisible();
  if (action === "create") {
    await dialog.locator("#key-label").fill(name);
    await dialog.getByRole("button", { name: "Create my PayLink key" }).click();
  } else {
    await dialog.getByRole("button", { name: "I already have a PayLink key" }).click();
  }
  await expect(dialog).toBeHidden();
  const account = await page.locator(".connect").getAttribute("title");
  expect(account).toMatch(/^0x[0-9a-fA-F]{40}$/);
  return account as Address;
}

/** Signs an invoice on the Monad terminal (the KeyCard first when `first`), behind the signing display. */
async function invoice(page: Page, amount: string, memo: string, first: boolean): Promise<void> {
  await page.goto(`${origin}/monad/`);
  await page.locator("#amount").fill(amount);
  await page.locator("#memo").fill(memo);
  await page.locator(".view-create > .key-primary").click();
  if (first) {
    await keyCard(page, "create");
  }
  await expect(page.locator(".signing")).toContainText("You are about to sign this invoice");
  await page.locator(".signing + .key-row .key-primary").click();
  await expect(page.locator(".ticket")).toBeVisible();
}

/** Everything the page's origin keeps: localStorage, sessionStorage and every IndexedDB record, as one string. */
async function storageDump(page: Page): Promise<{ readonly text: string; readonly stores: string[]; readonly localKeys: string[] }> {
  return await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("paylink");
      request.onsuccess = () => {
        resolve(request.result);
      };
      request.onerror = () => {
        reject(new Error("indexedDB"));
      };
    });
    const stores = [...db.objectStoreNames];
    const records: unknown[] = [];
    for (const name of stores) {
      records.push(
        await new Promise<unknown>((resolve) => {
          const request = db.transaction(name).objectStore(name).getAll();
          request.onsuccess = () => {
            resolve(request.result);
          };
        }),
      );
    }
    db.close();
    const local = Object.fromEntries(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]));
    const session = Object.fromEntries(Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k)]));
    return { text: JSON.stringify({ local, session, records }), stores: stores.sort(), localKeys: Object.keys(local).sort() };
  });
}

const spellings = (bytes: Buffer): string[] => [bytes.toString("hex"), bytes.toString("base64"), bytes.toString("base64url")];

test("Monad: one passkey, two keys — back up the ledger on one device, restore it on another; wrong passkey and tampering refused", async ({ browser }) => {
  // ---- Device A: the merchant's phone, two invoices with memos.
  const a = await device(browser);
  await addAuthenticator(a.context, a.page);
  await invoice(a.page, "25.50", "Logo design, invoice 042", true);
  await invoice(a.page, "12.00", "Kitenge × 2, Rasoa's shop", false);
  const merchant = (await a.page.locator(".connect").getAttribute("title")) as Address;
  await a.page.goto(`${origin}/monad/ledger/`);
  await expect(a.page.locator(".view-ledger > .links > li")).toHaveCount(2);
  const panelA = a.page.locator(".view-books");
  await expect(panelA.locator(".screen-top")).toContainText("PRF namespace paylink.books.v1");
  await expect(panelA.locator(".readings")).toContainText("Monad testnet");

  const saving = a.page.waitForEvent("download");
  await panelA.getByRole("button", { name: "Back up my ledger" }).click();
  const download = await saving;
  await expect(panelA.locator(".status.ok")).toContainText("Backup saved: 2 records, encrypted for your passkey.");
  await panelA.screenshot({ path: test.info().outputPath("ledger-backup-saved-1280-light.png") });
  expect(download.suggestedFilename()).toMatch(new RegExp(`^paylink-ledger-backup-${String(MONAD)}-${merchant.slice(0, 8).toLowerCase()}-\\d{4}-\\d{2}-\\d{2}\\.json$`));
  // Saved under the name the page gave it, as a browser does.
  const path = test.info().outputPath(download.suggestedFilename());
  await download.saveAs(path);
  const text = readFileSync(path, "utf8");
  // In clear: whose books, which network, how to derive the key. Encrypted: everything else.
  const file = JSON.parse(text) as { merchant: string; chain: string; schema: number; kdf: { namespace: string; salt: string; check: string }; cipher: { iv: string }; ciphertext: string };
  expect(file.merchant).toBe(merchant);
  expect(file.chain).toBe(`eip155:${String(MONAD)}`);
  expect(file.kdf.namespace).toBe("paylink.books.v1");
  for (const secret of ["Logo design", "Kitenge", "invoice 042"]) {
    expect(text).not.toContain(secret);
  }

  // ---- The second namespace does the work: the file opens with the books output's key, not with the account's.
  const record = JSON.parse((await a.page.evaluate(() => localStorage.getItem("paylink.passkey"))) ?? "{}") as { credentialId: string };
  const booksOutput = await prfOf(a.page, record.credentialId, createHash("sha256").update("paylink.books.v1").digest());
  const accountOutput = await prfOf(a.page, record.credentialId, createHash("sha256").update("mera.prf.salt.v1").digest());
  expect(booksOutput.equals(accountOutput)).toBe(false);
  const check = (output: Buffer): string => Buffer.from(hkdfSync("sha256", output, Buffer.alloc(32), "paylink.books.v1/check", 32)).toString("base64url");
  expect(check(booksOutput)).toBe(file.kdf.check);
  expect(check(accountOutput)).not.toBe(file.kdf.check);
  const key = Buffer.from(hkdfSync("sha256", booksOutput, Buffer.from(file.kdf.salt, "base64url"), `paylink.books.v1/aes-256-gcm/${file.chain}/${merchant}`, 32));
  const sealed = Buffer.from(file.ciphertext, "base64url");
  const header = { ...file } as Record<string, unknown>;
  delete header["ciphertext"];
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(file.cipher.iv, "base64url"));
  decipher.setAAD(Buffer.from(JSON.stringify(header), "utf8"));
  decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const content = JSON.parse(Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]).toString("utf8")) as { invoices: { signed: { memo: string } }[] };
  expect(content.invoices.map((i) => i.signed.memo).sort()).toEqual(["Kitenge × 2, Rasoa's shop", "Logo design, invoice 042"]);

  // Nothing secret is kept by device A: not the PRF outputs, not the AES key.
  const dumpA = await storageDump(a.page);
  expect(dumpA.stores).toEqual(["authorizations", "contacts", "invoices", "receipts"]);
  for (const spelled of [...spellings(booksOutput), ...spellings(accountOutput), ...spellings(key)]) {
    expect(dumpA.text).not.toContain(spelled);
  }

  // ---- Device B: a second profile with empty books; the same passkey, reached from it.
  const b = await device(browser, { phone: true, scheme: "dark" });
  const bridged = await bridgePasskey(b.context, a.page);
  await b.page.goto(`${origin}/monad/ledger/`);
  await expect(b.page.locator(".view-books .books-hint")).toContainText("Use your PayLink key to back up or restore");
  await b.page.locator(".connect").click();
  expect(await keyCard(b.page, "use")).toBe(merchant);
  await expect(b.page.locator(".view-ledger .empty-state")).toBeVisible();
  const panelB = b.page.locator(".view-books");

  // An altered copy first: refused after the fingerprint, nothing restored.
  const tampered = Buffer.from(sealed);
  tampered[40] = (tampered[40] ?? 0) ^ 0x01;
  const choosing = b.page.waitForEvent("filechooser");
  await panelB.getByRole("button", { name: "Restore from a file" }).click();
  await (await choosing).setFiles({ name: "altered.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...file, ciphertext: tampered.toString("base64url") })) });
  await expect(panelB.locator(".books-file-screen")).toContainText("Monad testnet");
  await panelB.getByRole("button", { name: "Unlock and restore" }).click();
  await expect(panelB.locator(".status.err")).toContainText("failed its integrity check");
  await expect(panelB.locator(".status.err")).toContainText("Error code BooksTampered");
  await expect(b.page.locator(".view-ledger .empty-state")).toBeVisible();

  // The genuine file: shown, unlocked with one fingerprint, merged; the ledger reads its books again.
  const choosingAgain = b.page.waitForEvent("filechooser");
  await panelB.getByRole("button", { name: "Restore from a file" }).click();
  await (await choosingAgain).setFiles(path);
  const review = panelB.locator(".books-file-screen");
  await expect(review).toContainText("Backup file");
  await expect(review).toContainText(merchant.slice(-4));
  await expect(b.page.locator(".view-books .books-review")).toBeVisible();
  expect(await axe(b.page)).toEqual([]);
  expect(await horizontalOverflow(b.page)).toBe(0);
  await panelB.screenshot({ path: test.info().outputPath("ledger-backup-review-390-dark.png") });
  const asked = bridged.length;
  await panelB.getByRole("button", { name: "Unlock and restore" }).click();
  await expect(panelB.locator(".status.ok")).toHaveText("Restored: 2 new, 0 already here.");
  expect(bridged.length).toBe(asked + 1);
  expect(bridged.at(-1)?.prfFirst).toBe(createHash("sha256").update("paylink.books.v1").digest("base64"));
  expect(bridged.at(-1)?.allow).toEqual([Buffer.from(record.credentialId, "base64url").toString("base64")]);
  const rows = b.page.locator(".view-ledger > .links > li .row-memo");
  await expect(rows).toHaveCount(2);
  expect((await rows.allTextContents()).sort()).toEqual(["Kitenge × 2, Rasoa's shop", "Logo design, invoice 042"]);
  const dumpB = await storageDump(b.page);
  expect(dumpB.stores).toEqual(["authorizations", "contacts", "invoices", "receipts"]);
  for (const spelled of [...spellings(booksOutput), ...spellings(accountOutput), ...spellings(key)]) {
    expect(dumpB.text).not.toContain(spelled);
  }

  // ---- Device C: another passkey, another account.
  const c = await device(browser);
  await addAuthenticator(c.context, c.page);
  await c.page.goto(`${origin}/monad/ledger/`);
  await c.page.locator(".connect").click();
  const other = await keyCard(c.page, "create", "Someone else");
  expect(other).not.toBe(merchant);
  const panelC = c.page.locator(".view-books");
  const pickA = c.page.waitForEvent("filechooser");
  await panelC.getByRole("button", { name: "Restore from a file" }).click();
  await (await pickA).setFiles(path);
  await expect(panelC.locator(".status.err")).toContainText("holds another account's ledger");
  await expect(panelC.locator(".status.err")).toContainText("Error code BooksOtherAccount");
  await expect(panelC.getByRole("button", { name: "Unlock and restore" })).toHaveCount(0);
  // The same file, its merchant edited to C's account: C's passkey cannot open it.
  const pickEdited = c.page.waitForEvent("filechooser");
  await panelC.getByRole("button", { name: "Restore from a file" }).click();
  await (await pickEdited).setFiles({ name: "edited.json", mimeType: "application/json", buffer: Buffer.from(text.replace(merchant, other)) });
  await panelC.getByRole("button", { name: "Unlock and restore" }).click();
  await expect(panelC.locator(".status.err")).toContainText("Not made with your passkey");
  await expect(panelC.locator(".status.err")).toContainText("Error code BooksWrongKey");
  await expect(c.page.locator(".view-ledger .empty-state")).toBeVisible();

  for (const d of [a, b, c]) {
    expect(d.problems).toEqual([]);
  }
});
