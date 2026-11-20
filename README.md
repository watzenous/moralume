# Moralume 🌙

**A simple token launchpad on GIWA, built with the [Ammora SDK](https://www.npmjs.com/package/@ammora-protocol/sdk).**

🔗 **Live:** https://www.moralume.fun (GIWA Sepolia testnet)

Built for the Ammora Builder Mission: *"Ship an exchange or launchpad with the Ammora SDK."*

## Features

- **🚀 Launch:** One transaction creates an ERC-20 token and its Ammora bonding curve. Name, ticker, description, links and image are stored on-chain.
- **📈 Trade:** Buy and sell on the bonding curve, with live quotes, slippage control, automatic ETH→WETH wrapping and exact-amount approvals.
- **🎓 Graduate:** When the curve fills, anyone can migrate it into a permanent Ammora ARL pool, where trading continues.
- **🔍 Explore:** Every Ammora launch on GIWA, with price, market cap, curve progress, a price chart and trade history.
- **👛 Wallet:** Connect, switch or disconnect any browser wallet (MetaMask etc.).
- **🔒 Static and private:** No backend, no API keys, no trackers. A strict CSP allows only the GIWA RPC and explorer.

## Ammora SDK usage

| Feature | SDK |
| --- | --- |
| Deployment and contracts | `giwaSepoliaAutoRouteDeployment`, `verifyAmmoraV4CoreAtBlock` |
| Launch Config | `getAmmoraV4ConfigAtBlock` |
| Token launch | `buildCreateAmmoraV4Launch`, `parseAmmoraV4LaunchCreatedReceipt` |
| Curve trading | `AmmoraV4LaunchCurveClient` (`quoteExactInputAtBlock`, `planSwapExactInput`), `classifyAmmoraV4ExactInputFill` |
| Graduation | `AmmoraV4LaunchCurveClient.planMigrateAtBlock` |
| Post-graduation swaps | `AmmoraSwapClient.prepareExactIn` |
| Launch discovery | `ammoraLaunchFactoryV4Abi` (`LaunchCreated`), `ammoraLaunchPoolV4Abi` |

Moralume uses its own launch Config **#67** (partner fee recipient: the Moralume wallet).

## Build (once, and again after every change)

You need Node.js 20 or newer (https://nodejs.org). Then, in Terminal:

```bash
cd ~/Desktop/moralume
npm install
npm run build
```

This produces:

```
dist/index.html   the whole site (upload this)
dist/_headers     extra security headers (Netlify / Cloudflare Pages use it automatically)
dist/.nojekyll    for GitHub Pages
```

To preview the site with a working wallet, run `npm run preview` and open the URL it prints.

## Settings

Edit `src/config.js`, then run `npm run build` again and re-upload `dist/`.

- `launchConfigId`: the Ammora launch Config every new token uses (Moralume: **#67**).
- `hiddenTokens`: token or curve addresses to hide from the site (moderation).
- `links`, `defaultSlippageBps`: footer links and default slippage.

## What the site connects to at runtime

The Content-Security-Policy only allows these two hosts:

| Host | Why |
| --- | --- |
| `https://sepolia-rpc.giwa.io` | Reading chain state (public GIWA RPC) |
| `https://sepolia-explorer.giwa.io` | Launch list and trade history (GIWA Blockscout API) |

There are no CDNs, no Google Fonts, no analytics, no IPFS gateways and no remote images.
Token metadata and images are read only from on-chain `data:` URIs.
Transactions are signed in the visitor's own wallet extension.

## Security notes

- **CSP:** Only the exact bundled script can run; it is allowed by its sha256 hash, recomputed on every build.
  If you edit `dist/index.html` by hand, the page stops working. Always edit `src/` and rebuild.
- **Headers:** If you host on your own server, add the headers from `dist/_headers` to your server config.
  Example for nginx:

  ```nginx
  add_header X-Frame-Options "DENY" always;
  add_header X-Content-Type-Options "nosniff" always;
  add_header Referrer-Policy "no-referrer" always;
  add_header Permissions-Policy "camera=(), microphone=(), geolocation=(), payment=()" always;
  add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
  ```

  The CSP is already inside the HTML as a `<meta>` tag.
- **HTTPS:** Serve the site over HTTPS. Browser wallets require it.
- **Dependencies:** The SDK and viem are pinned to exact versions. Only upgrade them on purpose, then rebuild and retest.
- **Network:** This is GIWA Sepolia testnet software. The Ammora SDK is beta and its contracts have no completed
  independent audit. Never use real funds.

## Source layout

```
src/app.js         application (imports the SDK and viem from node_modules)
src/config.js      your settings
src/template.html  layout and styles
build.mjs          bundles everything into dist/index.html and writes the CSP
```
