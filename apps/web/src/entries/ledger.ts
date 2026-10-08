// SPDX-License-Identifier: MIT
import "../styles/app.css";
import { boot } from "../app/boot.ts";
import { ledgerPage } from "../pages/ledger.ts";

void boot(ledgerPage);
