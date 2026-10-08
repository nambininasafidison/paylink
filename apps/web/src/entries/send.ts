// SPDX-License-Identifier: MIT
import "../styles/app.css";
import { boot } from "../app/boot.ts";
import { sendPage } from "../pages/send.ts";

void boot(sendPage);
