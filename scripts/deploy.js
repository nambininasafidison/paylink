// Deploy PayLink to Arc.
//   PRIVATE_KEY=0x... npm run deploy                 (Arc mainnet)
//   NETWORK=testnet PRIVATE_KEY=0x... npm run deploy (Arc testnet)
// Writes deployments/<network>.json and web/config.js.
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const artifact = require("../build/PayLink.json");

const NETWORKS = {
  mainnet: { chainId: 5042, rpc: "https://rpc.mainnet.arc.io", explorer: "https://explorer.arc.io" },
  testnet: { chainId: 5042002, rpc: "https://rpc.testnet.arc.io", explorer: "https://testnet.arcscan.app" },
};

async function main() {
  const name = process.env.NETWORK || "mainnet";
  const net = NETWORKS[name];
  if (!net) throw new Error("NETWORK must be mainnet or testnet");
  const key = process.env.PRIVATE_KEY;
  if (!key) throw new Error("Set PRIVATE_KEY (use a fresh wallet holding only a little USDC for gas)");
  const rpc = process.env.RPC_URL || net.rpc;

  const provider = new ethers.JsonRpcProvider(rpc, net.chainId, { staticNetwork: true });
  const { chainId } = await provider.getNetwork();
  const remote = Number(await provider.send("eth_chainId", []));
  if (remote !== net.chainId) throw new Error("RPC chainId " + remote + " != expected " + net.chainId);
  const wallet = new ethers.Wallet(key, provider);
  const bal = await provider.getBalance(wallet.address);
  console.log("Network  :", name, "(chainId " + chainId + ")");
  console.log("Deployer :", wallet.address);
  console.log("Balance  :", ethers.formatUnits(bal, 18), "USDC");
  if (bal === 0n) throw new Error("Deployer has no USDC for gas on Arc " + name);

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);
  const contract = await factory.deploy();
  const tx = contract.deploymentTransaction();
  console.log("Tx       :", net.explorer + "/tx/" + tx.hash);
  await contract.waitForDeployment();
  const address = await contract.getAddress();
  const receipt = await tx.wait();
  console.log("PayLink  :", address);
  console.log("Explorer :", net.explorer + "/address/" + address);

  const root = path.join(__dirname, "..");
  const deployment = {
    network: name, chainId: net.chainId, address, txHash: tx.hash, block: receipt.blockNumber,
    deployer: wallet.address, compiler: artifact.compiler, deployedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.join(root, "deployments"), { recursive: true });
  fs.writeFileSync(path.join(root, "deployments", name + ".json"), JSON.stringify(deployment, null, 2));
  fs.writeFileSync(path.join(root, "web", "config.js"),
    "window.PAYLINK_CONFIG = " + JSON.stringify({
      network: name, chainId: net.chainId, rpc: net.rpc, explorer: net.explorer, address, deployBlock: receipt.blockNumber,
    }, null, 2) + ";\n");
  console.log("Wrote deployments/" + name + ".json and web/config.js");
}

main().catch((e) => { console.error("Deploy failed:", e.shortMessage || e.message); process.exit(1); });
