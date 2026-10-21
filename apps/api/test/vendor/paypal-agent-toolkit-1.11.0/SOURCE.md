# Vendored PayPal Agent Toolkit tool definitions

Source files of <https://github.com/paypal/agent-toolkit> at commit `a3aa963960caf32912691a759879a8ce7a6018b2`
(`typescript/src/shared/`), the `gitHead` of the npm release `@paypal/agent-toolkit@1.11.0`. Kept as `.ts.txt` so that no
build, linter or type checker treats them as PayLink code: they are test data for the desk tools' parity with the
toolkit's tool contract (names, actions and parameter shapes), docs/paypal/SPEC.md §7.6 Plan B.

The npm package is **not** a dependency (ADR 0018): its runtime dependencies (AI SDK v4, openai, LangChain core, the MCP
SDK, the PayPal server SDK, axios, mathjs, lodash, dotenvx, zod 3) would enter the lockfile for a test. `zod` 4.6.5,
already pinned, ships the zod 3 API as `zod/v3`, enough to evaluate `parameters.ts` in a test.

Licence: the repository's `LICENSE` is Apache License 2.0 (copied unchanged); `typescript/package.json` says ISC. The two
disagree; both are permissive, and NOTICE.md cites both.

| File | sha256 |
|---|---|
| `tools.ts.txt` | `72624c2c0ee462e5b9236e02741788fb56074a57f348d53682937f4429251d6c` |
| `parameters.ts.txt` | `c2c3ee4fd82c73325f6c5320bbe2495916a73a120bdd39cfe5da356329531044` |
| `regex.ts.txt` | `dadca2b5f4cb49c9463cf3a92b2bc6fddf8db8afcc746993687a2419741da5dc` |
| `configuration.ts.txt` | `2a6ac96815a5279ec3fcfbcb94b0adb63d299d3f5821ae09fb1ae671a8e6300b` |
| `LICENSE` | `f76647726361173606e705b193434669b29a72e1c55becfe53601a07197802a8` |
