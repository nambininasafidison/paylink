// SPDX-License-Identifier: MIT
import "../styles/app.css";
import { boot } from "../app/boot.ts";
import { payPage } from "../pages/pay.ts";

void boot(payPage);
