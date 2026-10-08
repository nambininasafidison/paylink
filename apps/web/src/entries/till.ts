// SPDX-License-Identifier: MIT
import "../styles/app.css";
import { boot } from "../app/boot.ts";
import { tillPage } from "../pages/till.ts";

void boot(tillPage);
