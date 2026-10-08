// SPDX-License-Identifier: MIT
import "../styles/app.css";
import { boot } from "../app/boot.ts";
import { notFoundPage } from "../pages/notfound.ts";

void boot(notFoundPage);
