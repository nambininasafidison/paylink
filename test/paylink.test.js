// Runs PayLink against an in-process ganache chain.
const test = require("node:test");
const assert = require("node:assert");
const ganache = require("ganache");
const { ethers } = require("ethers");
const artifact = require("../build/PayLink.json");

const USDC = (n) => ethers.parseEther(String(n)); // Arc native USDC uses 18 decimals

let provider, payee, payer, other, paylink;

test.before(async () => {
  const g = ganache.provider({ logging: { quiet: true }, chain: { hardfork: "merge" }, wallet: { totalAccounts: 3, defaultBalance: 1000 } });
  provider = new ethers.BrowserProvider(g);
  [payee, payer, other] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  const f = new ethers.ContractFactory(artifact.abi, artifact.bytecode, payee);
  paylink = await f.deploy();
  await paylink.waitForDeployment();
});

async function expectRevert(promise, name) {
  try { await promise; } catch (e) {
    if (name) {
      // eth_call errors are decoded by ethers; eth_estimateGas ones carry raw data from ganache
      let parsed = e.revert;
      if (!parsed) {
        const raw = e.data || (e.info && e.info.error && e.info.error.data && e.info.error.data.result);
        parsed = raw ? paylink.interface.parseError(raw) : null;
      }
      assert.strictEqual(parsed && parsed.name, name);
    }
    return;
  }
  assert.fail("expected revert " + (name || ""));
}

test("fixed link: exact payment is forwarded to payee and closes the link", async () => {
  await (await paylink.connect(payee).create(USDC(25), 0, "Logo design #12")).wait();
  const id = 1n;
  const before = await provider.getBalance(await payee.getAddress());
  const tx = await paylink.connect(payer).pay(id, "thanks!", { value: USDC(25) });
  const rc = await tx.wait();
  const after = await provider.getBalance(await payee.getAddress());
  assert.strictEqual(after - before, USDC(25));
  assert.strictEqual(await provider.getBalance(await paylink.getAddress()), 0n);
  const l = await paylink.getLink(id);
  assert.strictEqual(l.active, false);
  assert.strictEqual(l.totalReceived, USDC(25));
  assert.strictEqual(l.payments, 1n);
  const ev = rc.logs.map((x) => paylink.interface.parseLog(x)).find((x) => x && x.name === "Paid");
  assert.strictEqual(ev.args.note, "thanks!");
  await expectRevert(paylink.connect(payer).pay(id, "", { value: USDC(25) }), "Inactive");
});

test("fixed link: wrong amount is rejected", async () => {
  await (await paylink.connect(payee).create(USDC(10), 0, "")).wait();
  await expectRevert(paylink.connect(payer).pay(2, "", { value: USDC(9) }), "WrongAmount");
  await expectRevert(paylink.connect(payer).pay(2, "", { value: USDC(11) }), "WrongAmount");
});

test("open link: accepts many payments of any amount", async () => {
  await (await paylink.connect(payee).create(0, 0, "Tip jar")).wait();
  await (await paylink.connect(payer).pay(3, "a", { value: USDC(1) })).wait();
  await (await paylink.connect(other).pay(3, "b", { value: USDC("0.5") })).wait();
  const l = await paylink.getLink(3);
  assert.strictEqual(l.active, true);
  assert.strictEqual(l.payments, 2n);
  assert.strictEqual(l.totalReceived, USDC("1.5"));
  await expectRevert(paylink.connect(payer).pay(3, "", { value: 0 }), "WrongAmount");
});

test("only the payee can cancel", async () => {
  await (await paylink.connect(payee).create(USDC(5), 0, "")).wait();
  await expectRevert(paylink.connect(other).cancel(4), "NotPayee");
  await (await paylink.connect(payee).cancel(4)).wait();
  await expectRevert(paylink.connect(payer).pay(4, "", { value: USDC(5) }), "Inactive");
});

test("expiry is enforced", async () => {
  const now = (await provider.getBlock("latest")).timestamp;
  await expectRevert(paylink.connect(payee).create(USDC(1), now - 1, ""), "BadExpiry");
  await (await paylink.connect(payee).create(USDC(1), now + 60, "")).wait();
  await provider.send("evm_increaseTime", [120]);
  await provider.send("evm_mine", []);
  await expectRevert(paylink.connect(payer).pay(5, "", { value: USDC(1) }), "Expired");
});

test("memo length is capped and unknown ids revert", async () => {
  await expectRevert(paylink.connect(payee).create(1, 0, "x".repeat(281)), "MemoTooLong");
  await expectRevert(paylink.getLink(999), "UnknownLink");
});

test("linksOf lists a payee's links; stray transfers are refused", async () => {
  const ids = await paylink.linksOf(await payee.getAddress());
  assert.deepStrictEqual(Array.from(ids), [1n, 2n, 3n, 4n, 5n]);
  await expectRevert(payer.sendTransaction({ to: await paylink.getAddress(), value: USDC(1) }));
});
