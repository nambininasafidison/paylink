// SPDX-License-Identifier: MIT
/**
 * Renders the static layers of a demo video (1920x1080) from its spec, with the app's own fonts (Archivo, Martian
 * Mono) and mark: the background (glow, logo, badge, phone labels, footer, progress track), the phone bezels, one
 * left column per caption, the idle client screen and the full-screen cards. compose.py stacks them over the
 * screencast frames. Usage: node layers.mjs <spec.json> <out dir>
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const [specPath, out] = process.argv.slice(2);
const spec = JSON.parse(readFileSync(specPath, "utf8"));
mkdirSync(out, { recursive: true });
const font = (f) => `file://${join(repo, "web/fonts", f)}`;
const mark = readFileSync(join(repo, "apps/web/public/icons/mark.svg"), "utf8");
const G = spec.geometry;

const css = `
@font-face { font-family: "Archivo"; src: url("${font("archivo-var-latin.woff2")}") format("woff2"); font-weight: 100 900; font-stretch: 62% 125%; }
@font-face { font-family: "Martian Mono"; src: url("${font("martian-mono-400-latin.woff2")}") format("woff2"); font-weight: 400; }
@font-face { font-family: "Martian Mono"; src: url("${font("martian-mono-600-latin.woff2")}") format("woff2"); font-weight: 600; }
:root { --bg: #0E0E0D; --ink: #ECE9E2; --ink-2: #C9C5BC; --muted: #8E8A82; --signal: #FF5A1F; --signal-ink: #FF7A45; --ok: #3DD68C; --rule: #2A2926;
  --sans: "Archivo", "Helvetica Neue", Arial, sans-serif; --mono: "Martian Mono", ui-monospace, monospace; }
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { width: 1920px; height: 1080px; background: transparent; overflow: hidden; }
body { font-family: var(--sans); color: var(--ink); -webkit-font-smoothing: antialiased; }
.bg { position: absolute; inset: 0; background:
  radial-gradient(900px 760px at 1560px 380px, rgba(150, 62, 22, .26), rgba(150, 62, 22, .08) 55%, rgba(0,0,0,0) 75%),
  radial-gradient(1200px 900px at 300px 1000px, rgba(255, 255, 255, .018), rgba(0,0,0,0) 70%), var(--bg); }
.dots { position: absolute; inset: 0; background-image: radial-gradient(rgba(255,255,255,.035) 1px, transparent 1.2px); background-size: 28px 28px; }
.brand { position: absolute; left: 96px; top: 70px; display: flex; align-items: center; gap: 18px; }
.brand svg { width: 44px; height: 44px; display: block; filter: drop-shadow(0 2px 6px rgba(0,0,0,.4)); }
.brand .word { font: 640 34px/1 var(--sans); letter-spacing: -.02em; }
.badge { margin-left: 16px; border: 1.5px solid #5d5a54; border-radius: 3px; padding: 7px 10px 6px; font: 400 14px/1 var(--mono); letter-spacing: .2em; color: var(--ink-2); white-space: nowrap; }
.label { position: absolute; top: ${G.labelY - 12}px; font: 400 17px/1 var(--mono); letter-spacing: .26em; color: var(--ink-2); text-align: center; white-space: nowrap; transform: translateX(-50%); }
.footer { position: absolute; left: 96px; top: 1018px; font: 400 14.5px/1.5 var(--mono); letter-spacing: .03em; color: var(--muted); white-space: nowrap; }
.track { position: absolute; left: 96px; top: ${G.barY}px; width: ${G.barW}px; height: 1px; background: #34322e; }
.phone { position: absolute; width: ${G.phoneW}px; height: ${G.phoneH}px; border-radius: 48px; background: #1b1a18;
  box-shadow: inset 0 0 0 2px #34322f, inset 0 0 0 9px #141412, 0 30px 70px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.03); }
.hole { position: absolute; left: ${G.inset}px; top: ${G.inset}px; width: ${G.screenW}px; height: ${G.screenH}px; border-radius: 36px; background: #000; box-shadow: 0 0 0 1.5px #0a0a09; }
.col { position: absolute; left: 96px; width: ${G.colW}px; }
.count { display: flex; align-items: center; gap: 18px; font: 600 26px/1 var(--mono); color: var(--signal-ink); letter-spacing: .06em; }
.count i { display: block; width: 64px; height: 1px; background: #5d5a54; }
.title { margin-top: 30px; font: 650 58px/1.06 var(--sans); letter-spacing: -.025em; color: var(--ink); }
.desc { margin-top: 26px; font: 400 29px/1.45 var(--sans); color: var(--ink-2); letter-spacing: -.005em; }
.desc b { color: var(--ink); font-weight: 600; }
.tag { margin-top: 34px; display: flex; align-items: center; gap: 14px; font: 400 16.5px/1.3 var(--mono); letter-spacing: .2em; color: var(--ink-2); text-transform: uppercase; }
.tag::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: var(--ok); box-shadow: 0 0 10px rgba(61,214,140,.6); flex: none; }
.idle { width: ${G.screenW}px; height: ${G.screenH}px; background: #111110; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 30px; }
.idle svg { width: 58px; height: 58px; opacity: .55; }
.idle span { font: 400 14px/1 var(--mono); letter-spacing: .26em; color: #6d6a64; }
.card { position: absolute; left: ${G.cardX}px; top: 0; width: 1700px; height: 1080px; }
.card .kicker { display: flex; align-items: center; gap: 12px; font: 400 16px/1 var(--mono); letter-spacing: .22em; color: var(--signal-ink); text-transform: uppercase; }
.card .kicker::before { content: ""; width: 9px; height: 9px; border-radius: 50%; background: var(--signal); }
.card h1 { font: 650 112px/1.0 var(--sans); letter-spacing: -.035em; color: var(--ink); }
.card h2 { font: 640 66px/1.08 var(--sans); letter-spacing: -.028em; color: var(--ink); }
.card em { font-style: normal; color: var(--signal-ink); }
.card p.lede { font: 400 36px/1.4 var(--sans); color: var(--ink-2); letter-spacing: -.01em; }
.card p.body { font: 400 29px/1.5 var(--sans); color: var(--ink-2); max-width: 1180px; }
.card .meta { font: 400 21px/1 var(--mono); letter-spacing: .24em; color: var(--ink-2); text-transform: uppercase; }
.card .fine { position: absolute; left: 0; top: 1004px; width: 1640px; padding-top: 18px; border-top: 1px solid #2c2a27; font: 400 15px/1.5 var(--mono); letter-spacing: .03em; color: var(--muted); white-space: nowrap; }
.card .brandbig { display: flex; align-items: center; gap: 22px; }
.card .brandbig svg { width: 96px; height: 96px; }
.card .brandbig .word { font: 650 70px/1 var(--sans); letter-spacing: -.03em; }
.card table { border-collapse: collapse; }
.card td { padding: 9px 0; vertical-align: baseline; }
.card td.k { width: 200px; font: 400 18px/1 var(--mono); letter-spacing: .22em; color: var(--muted); text-transform: uppercase; }
.card td.v { font: 400 29px/1.3 var(--mono); color: var(--ink); letter-spacing: -.01em; }
.stats { display: flex; gap: 0; margin-top: 64px; border-top: 1px solid #3a3834; }
.stat { flex: 1; padding: 26px 30px 0 0; }
.stat + .stat { padding-left: 30px; border-left: 1px solid #2c2a27; }
.stat b { display: block; font: 600 92px/1 var(--sans); letter-spacing: -.03em; color: var(--ink); font-variant-numeric: tabular-nums; }
.stat span { display: block; margin-top: 14px; font: 400 25px/1.35 var(--sans); color: var(--ink-2); }
.chip { display: inline-flex; align-items: center; gap: 10px; padding: 9px 16px 8px; border-radius: 999px; background: rgba(14,14,13,.92); border: 1.5px solid var(--signal); font: 600 15px/1 var(--mono); letter-spacing: .2em; color: var(--ink); text-transform: uppercase; }
`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const htmlFile = join(out, "_layer.html");
async function render(body, file, transparent = true, clip = undefined) {
  writeFileSync(htmlFile, `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${body}</body></html>`);
  await page.goto(`file://${htmlFile}`);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.screenshot({ path: join(out, file), omitBackground: transparent, ...(clip === undefined ? {} : { clip }) });
}
const esc = (s) => String(s).replace(/&/gu, "&amp;").replace(/</gu, "&lt;").replace(/>/gu, "&gt;");
/** Caption text: *word* is the accent, **word** is bold; everything else is escaped. */
const rich = (s) => esc(s).replace(/\*\*(.+?)\*\*/gu, "<b>$1</b>").replace(/\*(.+?)\*/gu, "<em>$1</em>");
const brand = `<div class="brand">${mark}<span class="word">${esc(spec.wordmark)}</span><span class="badge">${esc(spec.badge)}</span></div>`;

// Background: everything that never moves.
const labels = Object.entries(spec.labels).map(([side, text]) => `<div class="label" style="left:${side === "L" ? G.phoneLX + G.phoneW / 2 : G.phoneRX + G.phoneW / 2}px">${esc(text)}</div>`).join("");
const phones = `<div class="phone" style="left:${G.phoneLX}px;top:${G.phoneY}px"><div class="hole"></div></div><div class="phone" style="left:${G.phoneRX}px;top:${G.phoneY}px"><div class="hole"></div></div>`;
await render(`<div class="bg"></div><div class="dots"></div>${brand}${labels}${phones}<div class="track"></div><div class="footer">${esc(spec.footer)}</div>`, "bg.png", false);
await render(`<div class="idle">${mark}<span>${esc(spec.idle ?? "WAITING FOR A LINK")}</span></div>`, "idle.png", false, { x: 0, y: 0, width: G.screenW, height: G.screenH });
await render(`<span class="chip">${esc(spec.cutText ?? "cut")}</span>`, "chip.png", true, { x: 0, y: 0, width: 240, height: 44 });

// One left column per caption.
const total = spec.steps;
for (const [id, c] of Object.entries(spec.caps)) {
  if (c.card !== undefined) {
    continue;
  }
  const n = String(c.n).padStart(2, "0");
  const body = `<div class="col" style="top:${G.colTop}px"><div class="count">${n} / ${String(total).padStart(2, "0")}<i></i></div><div class="title">${rich(c.title)}</div><div class="desc">${rich(c.desc)}</div>${c.tag ? `<div class="tag">${esc(c.tag)}</div>` : ""}</div>`;
  await render(body, `cap_${id}.png`);
}
// Full-screen cards.
for (const [id, c] of Object.entries(spec.cards)) {
  await render(`<div class="bg"></div><div class="dots"></div><div class="card">${c.html.replaceAll("{{mark}}", mark)}</div>`, `card_${id}.png`, false);
}
await browser.close();
writeFileSync(join(out, "layers.json"), JSON.stringify({ geometry: G }, null, 1));
console.log("layers in", out);
