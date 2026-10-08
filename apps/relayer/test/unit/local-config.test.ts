// SPDX-License-Identifier: MIT
/** The local relayer's config file: anvil chains only, validated, turned into registry entries. */
import { createRegistry, MONAD_GAS_TABLE, monadTestnet, SNAPSHOT_GAS_TABLE } from "@paylink/chains";
import { describe, expect, it } from "vitest";
import { localChainsFromJson } from "../../src/node/local-config.ts";

const config = {
  port: 8787,
  allowedOrigins: ["http://127.0.0.1:5173"],
  chains: [
    {
      chainId: 10143,
      rpcUrl: "http://127.0.0.1:8545",
      deployment: "0x5FbDB2315678afecb367f032d93F642f64180aa3",
      gas: "monad",
      tokens: [{ address: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512", symbol: "AUSD", decimals: 6, eip712Domain: { name: "Agora Dollar", version: "1" } }],
      faucet: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0",
    },
    { chainId: 84532, rpcUrl: "http://localhost:8546", deployment: "0x5FbDB2315678afecb367f032d93F642f64180aa3", tokens: [{ address: "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512", symbol: "USDC", decimals: 6, eip2612: true }] },
  ],
};

describe("local relayer config", () => {
  it("builds local registry entries with the right gas tables and the registry's faucet bounds", () => {
    const parsed = localChainsFromJson(config);
    expect(parsed.port).toBe(8787);
    expect(parsed.allowedOrigins).toEqual(["http://127.0.0.1:5173"]);
    const [monad, base] = parsed.chains;
    expect(monad).toMatchObject({ chainId: 10143, local: true, gas: MONAD_GAS_TABLE, gasModel: { chargesGasLimit: true } });
    expect(monad?.contracts.ausdFaucet).toEqual({ address: "0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0", confidence: "C", gas: monadTestnet.contracts.ausdFaucet?.gas });
    expect(monad?.tokens[0]).toMatchObject({ symbol: "AUSD", listing: "default", capabilities: { eip3009: true, eip2612: false }, eip712Domain: { name: "Agora Dollar", version: "1" } });
    expect(base).toMatchObject({ chainId: 84532, gas: SNAPSHOT_GAS_TABLE, contracts: {}, gasModel: { chargesGasLimit: false } });
    expect(base?.tokens[0]).toMatchObject({ capabilities: { eip3009: true, eip2612: true }, eip712Domain: null });
    expect(createRegistry(parsed.chains).chains).toHaveLength(2);
  });

  it.each([
    ["a remote RPC", { ...config, chains: [{ ...config.chains[0], rpcUrl: "https://testnet-rpc.monad.xyz" }] }],
    ["an extra key", { ...config, relayerKey: "0x00" }],
    ["no chain", { ...config, chains: [] }],
    ["a bad address", { ...config, chains: [{ ...config.chains[0], deployment: "0x1234" }] }],
  ])("refuses %s", (_name, json) => {
    expect(() => localChainsFromJson(json)).toThrow();
  });
});
