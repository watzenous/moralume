// Builds dist/index.html: ONE self-contained file with the app, the Ammora SDK, viem and the fonts
// inlined. At runtime the page talks only to the GIWA RPC and the GIWA block explorer (enforced by CSP).
//
//   npm install      (once)
//   npm run build    → dist/index.html, dist/_headers, dist/.nojekyll
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const RPC = "https://sepolia-rpc.giwa.io";
const EXPLORER = "https://sepolia-explorer.giwa.io";

// 1) Bundle app + SDK + viem into one minified ES module.
const result = await build({
  entryPoints: ["src/app.js"],
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  legalComments: "none",
  write: false,
  logLevel: "warning",
});
let js = result.outputFiles[0].text;
if (/<\/script/i.test(js)) js = js.replace(/<\/script/gi, "<\\/script");

// 2) Fonts from @fontsource, embedded as data: URIs (no Google Fonts requests).
async function fontFaces(pkg, family, weights) {
  const dir = join("node_modules", "@fontsource", pkg, "files");
  const files = await readdir(dir);
  const css = [];
  for (const w of weights) {
    const name = files.find((f) => f === `${pkg}-latin-${w}-normal.woff2`);
    if (!name) throw new Error(`Missing font file ${pkg} ${w} in ${dir}`);
    const b64 = (await readFile(join(dir, name))).toString("base64");
    css.push(`@font-face{font-family:"${family}";font-style:normal;font-weight:${w};font-display:swap;src:url(data:font/woff2;base64,${b64}) format("woff2")}`);
  }
  return css.join("\n");
}
const fonts = [
  await fontFaces("plus-jakarta-sans", "Plus Jakarta Sans", [400, 500, 600, 700, 800]),
  await fontFaces("jetbrains-mono", "JetBrains Mono", [400, 500]),
].join("\n");

// 3) Strict Content-Security-Policy: only this exact inline script may run (sha256 hash).
const scriptHash = createHash("sha256").update(js, "utf8").digest("base64");
const csp = [
  "default-src 'none'",
  `script-src 'sha256-${scriptHash}'`,
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  `connect-src ${RPC} ${EXPLORER}`,
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
].join("; ");

const template = await readFile("src/template.html", "utf8");
const html = template
  .replace("__CSP__", csp)
  .replace("/*__FONTS__*/", () => fonts)
  .replace("/*__APP__*/", () => js);

await mkdir("dist", { recursive: true });
await writeFile("dist/index.html", html);
await writeFile("dist/.nojekyll", "");
// Extra HTTP security headers (used automatically by Netlify and Cloudflare Pages).
await writeFile("dist/_headers", `/*
  Content-Security-Policy: ${csp}; frame-ancestors 'none'
  X-Frame-Options: DENY
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=()
  Strict-Transport-Security: max-age=31536000; includeSubDomains
`);
console.log(`dist/index.html  ${(html.length / 1024).toFixed(0)} KB  (script sha256-${scriptHash.slice(0, 12)}…)`);
