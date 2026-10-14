// SPDX-License-Identifier: MIT
/**
 * Borrowing MUSD against bitcoin on Mezo testnet, read live: the smallest loan that covers what a payer lacks, and the
 * test BTC it needs as collateral, so a payer can pay an invoice without selling bitcoin (docs/research/mezo.md §4, §8).
 *
 * Read-only `eth_call`s, never a transaction: MUSD's BorrowerOperations (the registry's `musdBorrowerOperations`), and
 * the PriceFeed and TroveManager it names itself. The rules are those of `BorrowerOperations._openTrove` in
 * mezo-org/musd at aa25fd6: the borrower receives exactly the amount asked; outside recovery mode a borrowing fee
 * (`amount × borrowingRate / 1e18`) is added to the debt, and amount + fee must reach `minNetDebt`; the gas compensation
 * (`MUSD_GAS_COMPENSATION`) is added on top; collateral × price / debt must reach MCR (CCR in recovery mode). The loan
 * asked is at least `minNetDebt` itself, the smallest loan Mezo's own guide names, and the collateral is rounded up.
 * The figure is a floor: a loan that close to the ratio is liquidated by a small fall in the price of bitcoin.
 *
 * Used by the Mezo edition only (its funds row and Status page); other editions never import it.
 */
import type { ChainDefinition, Token } from "@paylink/chains";
import { formatAmountLocale } from "@paylink/sdk";
import { LOCALE_INFO } from "@paylink/i18n";
import type { Locale } from "@paylink/i18n";
import { getAddress } from "viem";
import type { Address, Hex } from "viem";
import type { App } from "../../app/context.ts";
import type { ChainClient } from "../../core/clients.ts";
import { displayAmount } from "../../core/format.ts";

const UNIT = 10n ** 18n;

/** Selectors of the views read (cast sig), checked against the musd artifacts' ABIs at aa25fd6. */
const SELECTOR = {
  musd: "0xcab666d0",
  minNetDebt: "0x969c2452",
  gasCompensation: "0x7af110ba", // MUSD_GAS_COMPENSATION()
  borrowingRate: "0xb5b8453e",
  mcr: "0x794e5724",
  ccr: "0x5733d58f",
  priceFeed: "0x741bef1a",
  troveManager: "0x3d83908a",
  fetchPrice: "0x0fdb11cf",
  checkRecoveryMode: "0x4e443d9e", // checkRecoveryMode(uint256)
} as const;

/** MUSD's lending terms on the chain now. All 18-decimal fixed point, like the contracts. */
export interface LoanTerms {
  readonly minNetDebt: bigint;
  readonly gasCompensation: bigint;
  readonly borrowingRate: bigint;
  readonly mcr: bigint;
  readonly ccr: bigint;
  /** USD per BTC from MUSD's PriceFeed. */
  readonly price: bigint;
  readonly recovery: boolean;
}

/** The smallest loan that covers a shortfall, and what it takes. */
export interface LoanEstimate {
  /** MUSD the borrower receives. */
  readonly loan: bigint;
  /** The trove's debt: the loan, the borrowing fee and the gas compensation. */
  readonly debt: bigint;
  /** The collateral ratio the loan must reach (MCR, or CCR in recovery mode). */
  readonly ratio: bigint;
  /** BTC (18 decimals) at that ratio, rounded up to 0.00001 BTC. */
  readonly collateral: bigint;
  readonly price: bigint;
}

/** The first 32-byte word of return data, as an unsigned integer (`0` for no data). */
const word = (data: Hex | undefined): bigint => (data === undefined || data.length < 66 ? 0n : BigInt(data.slice(0, 66)));
/** The address in the first 32-byte word of return data. */
const address = (data: Hex | undefined): Address => getAddress(`0x${(data ?? "").slice(26, 66).padStart(40, "0")}`);

/**
 * Reads the lending terms from the BorrowerOperations the registry names for `chain`, after checking it lends `token`.
 * Throws when the chain has none, when it lends another token, or when the network does not answer.
 */
export async function readLoanTerms(client: Pick<ChainClient, "call">, chain: ChainDefinition, token: Token): Promise<LoanTerms> {
  const operations = chain.contracts.musdBorrowerOperations?.address;
  if (operations === undefined) {
    throw new Error(`no MUSD BorrowerOperations on chain ${String(chain.chainId)}`);
  }
  const read = async (to: Address, data: Hex): Promise<Hex | undefined> => (await client.call({ to, data })).data;
  const [musd, minNetDebt, gasCompensation, borrowingRate, mcr, ccr, priceFeed, troveManager] = await Promise.all(
    [SELECTOR.musd, SELECTOR.minNetDebt, SELECTOR.gasCompensation, SELECTOR.borrowingRate, SELECTOR.mcr, SELECTOR.ccr, SELECTOR.priceFeed, SELECTOR.troveManager].map(
      async (selector) => await read(operations, selector),
    ),
  );
  if (address(musd) !== getAddress(token.address)) {
    throw new Error("the BorrowerOperations does not lend this token");
  }
  const price = word(await read(address(priceFeed), SELECTOR.fetchPrice));
  const recovery = word(await read(address(troveManager), `${SELECTOR.checkRecoveryMode}${price.toString(16).padStart(64, "0")}`)) !== 0n;
  const terms = { minNetDebt: word(minNetDebt), gasCompensation: word(gasCompensation), borrowingRate: word(borrowingRate), mcr: word(mcr), ccr: word(ccr), price, recovery };
  if (terms.price === 0n || terms.mcr === 0n || terms.minNetDebt === 0n) {
    throw new Error("the lending terms read as zero");
  }
  return terms;
}

/** `a / b` rounded up (positive integers). */
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/**
 * The smallest loan that covers `shortfall` MUSD (18 decimals): whole MUSD, at least `minNetDebt`; its debt as the
 * contract books it, and the BTC collateral at the ratio the chain asks now.
 */
export function smallestLoan(terms: LoanTerms, shortfall: bigint): LoanEstimate {
  const asked = ceilDiv(shortfall > 0n ? shortfall : 1n, UNIT) * UNIT;
  const loan = asked > terms.minNetDebt ? asked : terms.minNetDebt;
  const fee = terms.recovery ? 0n : (loan * terms.borrowingRate) / UNIT;
  const debt = loan + fee + terms.gasCompensation;
  const ratio = terms.recovery ? terms.ccr : terms.mcr;
  const step = 10n ** 13n; // 0.00001 BTC
  const collateral = ceilDiv(ceilDiv(debt * ratio, terms.price), step) * step;
  return { loan, debt, ratio, collateral, price: terms.price };
}

/** The figures of an estimate, in the language's number format: amounts exact, the ratio in percent, the price in dollars. */
export function loanParams(estimate: LoanEstimate, locale: Locale): { loan: string; debt: string; btc: string; ratio: string; price: string } {
  const numbers = LOCALE_INFO[locale].numberLocale;
  return {
    loan: displayAmount(estimate.loan, { decimals: 18 }, locale),
    debt: displayAmount(estimate.debt, { decimals: 18 }, locale),
    btc: formatAmountLocale(estimate.collateral, 18, numbers, { minFractionDigits: 0 }),
    ratio: formatAmountLocale((estimate.ratio * 100n) / UNIT, 0, numbers, { minFractionDigits: 0 }),
    price: formatAmountLocale(estimate.price / UNIT, 0, numbers, { minFractionDigits: 0 }),
  };
}

/** "Or borrow MUSD without selling bitcoin: …", for the funds row of a payer short of `shortfall` MUSD. */
export async function borrowLine(app: App, chain: ChainDefinition, token: Token, shortfall: bigint): Promise<string> {
  const terms = await readLoanTerms(app.client(chain), chain, token);
  return app.i18n.t("mezo.borrow.line", loanParams(smallestLoan(terms, shortfall), app.locale));
}
