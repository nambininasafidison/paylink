// SPDX-License-Identifier: MIT
/**
 * The PayPal edition's stylesheet, loaded by `boot` in that edition only (behind its build-time constant), before the
 * page renders. Its modules import no CSS themselves: they are side-effect free, so the other editions' pages, which
 * import them unused, drop them whole and never carry a byte of this stylesheet.
 *
 * Owner: web edition workstream.
 */
import "./paypal.css";
