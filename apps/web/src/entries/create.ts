// SPDX-License-Identifier: MIT
import "../styles/app.css";
import { boot } from "../app/boot.ts";
import { createPage } from "../pages/create.ts";

void boot(createPage);
