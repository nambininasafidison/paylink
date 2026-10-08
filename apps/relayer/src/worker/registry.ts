// SPDX-License-Identifier: MIT
/**
 * The registry the Worker relays from: the shipped `@paylink/chains` registry, testnets only. A module of its own so
 * that the workerd test suite (test/integration/worker.test.ts) can bundle the very same Worker against anvil
 * (scripts/build.ts `registryModule`); the production bundle is always built from this file, and
 * test/unit/deploy.test.ts checks that deploy/worker.js says so.
 */
export { registry as source } from "@paylink/chains";

/** Local (anvil) chains are never relayed by the Worker. Only the test bundle's replacement module sets this. */
export const allowLocal = false;
