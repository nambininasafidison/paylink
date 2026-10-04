// Compile contracts/PayLink.sol with solc-js (no network needed) into build/PayLink.json.
const fs = require("fs");
const path = require("path");
const solc = require("solc");

const root = path.join(__dirname, "..");
const source = fs.readFileSync(path.join(root, "contracts", "PayLink.sol"), "utf8");
const input = {
  language: "Solidity",
  sources: { "PayLink.sol": { content: source } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "paris",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};
const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === "error");
for (const e of out.errors || []) console.error(e.formattedMessage);
if (errors.length) process.exit(1);

const c = out.contracts["PayLink.sol"].PayLink;
const artifact = { contractName: "PayLink", compiler: solc.version(), abi: c.abi, bytecode: "0x" + c.evm.bytecode.object };
fs.mkdirSync(path.join(root, "build"), { recursive: true });
fs.writeFileSync(path.join(root, "build", "PayLink.json"), JSON.stringify(artifact, null, 2));
// The web app needs the ABI, and the in-browser deployer needs the bytecode.
fs.writeFileSync(path.join(root, "web", "abi.js"), "window.PAYLINK_ABI = " + JSON.stringify(c.abi) + ";\n");
fs.writeFileSync(path.join(root, "web", "bytecode.js"),
  "window.PAYLINK_BYTECODE = " + JSON.stringify(artifact.bytecode) + ";\nwindow.PAYLINK_COMPILER = " + JSON.stringify(artifact.compiler) + ";\n");
// Standard JSON input, for source verification on the Arc explorer.
fs.mkdirSync(path.join(root, "verify"), { recursive: true });
fs.writeFileSync(path.join(root, "verify", "PayLink.standard-input.json"), JSON.stringify(input, null, 2));
console.log("Compiled PayLink with solc " + solc.version());
