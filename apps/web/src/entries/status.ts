// SPDX-License-Identifier: MIT
import "../styles/app.css";
import { boot } from "../app/boot.ts";
import { statusPage } from "../pages/status.ts";

void boot(statusPage);
