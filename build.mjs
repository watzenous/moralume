// Builds dist/: a small index.html plus content-hashed, long-cacheable files in dist/assets/
// (app code, an on-demand swap module, CSS and fonts). Everything is self-hosted: at runtime the
// page talks only to the GIWA RPC and the GIWA block explorer (enforced by CSP).
//
//   npm install      (once)
//   npm run build    → dist/index.html, dist/assets/*, dist/_headers, dist/.nojekyll
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const RPC = "https://sepolia-rpc.giwa.io";
const EXPLORER = "https://sepolia-explorer.giwa.io";
const OUT = "dist";
const ASSETS = join(OUT, "assets");

const hash = (buf, n = 10) => createHash("sha256").update(buf).digest("hex").slice(0, n);
const sri = (buf) => "sha384-" + createHash("sha384").update(buf).digest("base64");
const kb = (n) => `${(n / 1024).toFixed(0)} KB`;

await rm(ASSETS, { recursive: true, force: true }); // drop old hashed files
await mkdir(join(ASSETS, "fonts"), { recursive: true });

// 1) JavaScript, as two ES modules:
//    - swap-*.js: AmmoraSwapClient (most of the SDK's code, only needed for graduated tokens),
//      loaded on demand;
//    - app-*.js: everything else (app + the rest of the SDK + viem), loaded on every visit.
const esm = { bundle: true, format: "esm", platform: "browser", target: ["es2022"], minify: true, legalComments: "none", write: false, logLevel: "warning" };
const swapJs = (await build({ ...esm, entryPoints: ["src/swap-client.js"] })).outputFiles[0].contents;
const swapFile = `swap-${hash(swapJs)}.js`;
await writeFile(join(ASSETS, swapFile), swapJs);
const appJs = (await build({ ...esm, entryPoints: ["src/app.js"], define: { __SWAP_MODULE__: JSON.stringify(`./${swapFile}`) },
  external: ["./swap-*"] })).outputFiles[0].contents;
const entryFile = `app-${hash(appJs)}.js`;
await writeFile(join(ASSETS, entryFile), appJs);

// 2) Tiny theme script that runs before first paint (avoids a white flash in night mode).
const theme = await build({ entryPoints: ["src/theme-init.js"], bundle: true, format: "iife", minify: true, write: false, logLevel: "warning" });
const themeJs = theme.outputFiles[0].contents;
const themeFile = `theme-${hash(themeJs)}.js`;
await writeFile(join(ASSETS, themeFile), themeJs);

// 3) Fonts from @fontsource as separate woff2 files (no Google Fonts requests).
async function fontFaces(pkg, family, weights) {
  const dir = join("node_modules", "@fontsource", pkg, "files");
  const files = await readdir(dir);
  const css = [];
  for (const w of weights) {
    const name = files.find((f) => f === `${pkg}-latin-${w}-normal.woff2`);
    if (!name) throw new Error(`Missing font file ${pkg} ${w} in ${dir}`);
    const buf = await readFile(join(dir, name));
    const out = `${pkg}-${w}-${hash(buf, 8)}.woff2`;
    await copyFile(join(dir, name), join(ASSETS, "fonts", out));
    css.push(`@font-face{font-family:"${family}";font-style:normal;font-weight:${w};font-display:swap;src:url(fonts/${out}) format("woff2")}`);
  }
  return css.join("\n");
}
const fonts = [
  await fontFaces("plus-jakarta-sans", "Plus Jakarta Sans", [400, 500, 600, 700, 800]),
  await fontFaces("jetbrains-mono", "JetBrains Mono", [400, 500]),
].join("\n");

// 4) Stylesheet (minified by esbuild).
const rawCss = (await readFile("src/style.css", "utf8")).replace("/*__FONTS__*/", () => fonts);
const css = (await build({ stdin: { contents: rawCss, loader: "css" }, minify: true, write: false, logLevel: "warning" })).outputFiles[0].contents;
const cssFile = `style-${hash(css)}.css`;
await writeFile(join(ASSETS, cssFile), css);

// 5) Strict Content-Security-Policy: scripts, styles and fonts only from this site.
//    ('unsafe-inline' for styles covers style="" attributes in the rendered HTML.)
const csp = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src data: blob:",
  "font-src 'self'",
  `connect-src ${RPC} ${EXPLORER}`,
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join("; ");

const headAssets = [
  `<link rel="stylesheet" href="assets/${cssFile}" integrity="${sri(css)}" />`,
  `<link rel="preload" href="assets/fonts/${(await readdir(join(ASSETS, "fonts"))).find((f) => f.startsWith("plus-jakarta-sans-400-"))}" as="font" type="font/woff2" crossorigin />`,
  `<script src="assets/${themeFile}" integrity="${sri(themeJs)}"></script>`,
].join("\n");
const appScript = `<script type="module" src="assets/${entryFile}" integrity="${sri(appJs)}"></script>`;

const template = await readFile("src/template.html", "utf8");
const html = template
  .replace("__CSP__", csp)
  .replace("__HEAD_ASSETS__", () => headAssets)
  .replace("__APP_SCRIPT__", () => appScript);

await writeFile(join(OUT, "index.html"), html);
await writeFile(join(OUT, ".nojekyll"), "");
// HTTP headers (used automatically by Netlify and Cloudflare Pages). Hashed assets never change,
// so browsers may cache them for a year; index.html is always revalidated so updates show at once.
await writeFile(join(OUT, "_headers"), `/*
  Content-Security-Policy: ${csp}; frame-ancestors 'none'
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
  Strict-Transport-Security: max-age=31536000; includeSubDomains

/assets/*
  Cache-Control: public, max-age=31536000, immutable

/
  Cache-Control: no-cache

/index.html
  Cache-Control: no-cache
`);

// Summary
console.log(`dist/index.html          ${kb(html.length)}`);
console.log(`first load JS            ${kb(appJs.length)}  (assets/${entryFile})`);
console.log(`swap module (on demand)  ${kb(swapJs.length)}  (assets/${swapFile})`);
console.log(`css                      ${kb(css.length)}`);
