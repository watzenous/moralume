
// Moralume — a token launchpad + bonding-curve exchange built on the Ammora SDK.
// Everything on-chain goes through @ammora-protocol/sdk (Ammora V4 launch factory, ALC curve,
// graduation/migration, ARL pool swaps, Config registry) on GIWA Sepolia.
import * as A from "@ammora-protocol/sdk";
import {
  createPublicClient, createWalletClient, custom, http, defineChain, formatUnits, parseUnits,
  erc20Abi, getAddress, isAddress, decodeEventLog, toEventSelector, encodeFunctionData, zeroAddress, toHex,
} from "viem";

import { SITE } from "./config.js";



/* ───────────────────────────── deployment ───────────────────────────── */
const D = A.giwaSepoliaAutoRouteDeployment;               // reviewed Ammora V4 auto-route catalog
const L = D.contracts.launch;                             // factory, registry, adapter, fee policy …
const CORE = { configRegistry: L.configRegistry, launchFactory: L.factory, graduationAdapter: L.graduationAdapter, feePolicy: L.feePolicy };
const CHAIN_ID = D.chain.id;                              // 91342
const RPC = D.chain.rpcUrls[0];                           // https://sepolia-rpc.giwa.io
const EXPLORER = D.chain.blockExplorerUrl;                // https://sepolia-explorer.giwa.io
const WETH = getAddress(D.contracts.tokens.wrappedNative);
const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const FACTORY_START = 36220000;

const chain = defineChain({
  id: CHAIN_ID, name: D.chain.name, nativeCurrency: D.chain.nativeCurrency,
  rpcUrls: { default: { http: [RPC] } },
  blockExplorers: { default: { name: "GIWA Explorer", url: EXPLORER } },
  contracts: { multicall3: { address: MULTICALL3 } },
});
const pc = createPublicClient({
  chain,
  transport: http(RPC, { retryCount: 4, retryDelay: 700 }),
  batch: { multicall: { wait: 16, batchSize: 4096 } },
});

const LAUNCH_EVENT = A.ammoraLaunchFactoryV4Abi.find((x) => x.type === "event" && x.name === "LaunchCreated");
const SWAP_EVENT = A.ammoraLaunchPoolV4Abi.find((x) => x.type === "event" && x.name === "Swap");
const LAUNCH_TOPIC = toEventSelector(LAUNCH_EVENT);
const SWAP_TOPIC = toEventSelector(SWAP_EVENT);
const wethAbi = [
  { type: "function", name: "deposit", stateMutability: "payable", inputs: [], outputs: [] },
  { type: "function", name: "withdraw", stateMutability: "nonpayable", inputs: [{ type: "uint256", name: "wad" }], outputs: [] },
];

const siteConfigId = () => BigInt(SITE.launchConfigId);
// Moderation: tokens listed in SITE.hiddenTokens (token or curve address) are not shown anywhere on this site.
const HIDDEN = new Set((SITE.hiddenTokens || []).map((a) => String(a).toLowerCase()));
const isHidden = (...addrs) => addrs.some((a) => a && HIDDEN.has(String(a).toLowerCase()));
// "Official" tokens: launched on-chain by the launchpad's own wallet (or listed explicitly).
const OFFICIAL_CREATORS = new Set((SITE.officialCreators || []).map((a) => String(a).toLowerCase()));
const OFFICIAL_TOKENS = new Set((SITE.officialTokens || []).map((a) => String(a).toLowerCase()));
const isOfficial = (x) => !!x && (OFFICIAL_TOKENS.size
  ? [x.token, x.curve].some((a) => a && OFFICIAL_TOKENS.has(String(a).toLowerCase()))
  : !!x.creator && OFFICIAL_CREATORS.has(String(x.creator).toLowerCase()));
const officialBadge = (x) => (isOfficial(x) ? `<span class="badge b-official" title="Launched by the ${esc(SITE.name)} team">✓ Official</span>` : "");

/* ───────────────────────────── small helpers ───────────────────────────── */
const $ = (sel, root = document) => root.querySelector(sel);
const app = $("#app");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const txUrl = (h) => `${EXPLORER}/tx/${h}`;
const addrUrl = (a) => `${EXPLORER}/address/${a}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nowSec = () => BigInt(Math.floor(Date.now() / 1000));
const bnJson = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

function fmtNum(n, digits = 4) {
  if (!isFinite(n)) return "—";
  if (n === 0) return "0";
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + "B";
  if (a >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (a >= 1e4) return (n / 1e3).toFixed(1) + "K";
  if (a >= 1) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (a >= 1e-4) return n.toLocaleString("en-US", { maximumSignificantDigits: digits });
  return fmtTiny(n);
}
// 0.0₉214 style for very small prices
function fmtTiny(p) {
  if (!p) return "0";
  const e = Math.floor(-Math.log10(p));
  const sig = Math.round(p * 10 ** (e + 2));
  return `0.0<sub>${e - 1}</sub>${String(sig).replace(/0+$/, "") || "0"}`;
}
const fmtUnits = (v, dec, digits) => fmtNum(Number(formatUnits(v ?? 0n, dec)), digits);
const sqrtToPrice = (sqrtQ64, baseDec, quoteDec = 18) => {
  const s = Number(sqrtQ64) / 2 ** 64;
  return s * s * 10 ** (baseDec - quoteDec);
};
const errText = (e) => {
  if (!e) return "Unknown error";
  if (e.code === 4001 || /User (rejected|denied)/i.test(e.message || "")) return "Request rejected in your wallet.";
  // SDK errors carry the underlying contract revert in details.causeMessage.
  const cause = e.details && typeof e.details === "object" ? String(e.details.causeMessage || "") : "";
  const reason = (cause || e.shortMessage || e.message || "").match(/Error: (\w+)\(/)?.[1];
  if (reason === "PriceRangeViolation") return "This amount is larger than the pool's liquidity range allows. Try a smaller amount.";
  const base = e.shortMessage || (typeof e.details === "string" ? e.details : "") || e.message || String(e);
  return reason ? `${base} (${reason})` : base;
};
function toast(html, kind = "", ms = 6000) {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = html;
  $("#toasts").appendChild(el);
  setTimeout(() => el.remove(), ms);
}
function timeAgo(sec) {
  if (!sec) return "";
  const d = Date.now() / 1000 - sec;
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86400)}d ago`;
}

/* ───────────────────────────── metadata ───────────────────────────── */
const b64ToUtf8 = (b) => new TextDecoder().decode(Uint8Array.from(atob(b), (c) => c.charCodeAt(0)));
// Outbound links shown on token pages (website / X / Telegram): https only.
const safeUrl = (u) => {
  if (!u || typeof u !== "string" || u.length > 300) return null;
  try { const x = new URL(u); return x.protocol === "https:" ? x.href : null; } catch { return null; }
};
// Images: only inline data: images stored in the on-chain metadata (no remote image loads).
const safeImg = (u) => (typeof u === "string" && u.length < 200_000 && /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(u) ? u : null);

const metaCache = new Map();
// Privacy: metadata is read ONLY from on-chain data: URIs. Remote (https/ipfs) metadata is never
// fetched, so token creators cannot learn visitors' IP addresses through a metadata link.
async function readMetadata(uri) {
  if (!uri) return {};
  if (metaCache.has(uri)) return metaCache.get(uri);
  let out = {};
  try {
    if (uri.startsWith("data:application/json;base64,")) out = JSON.parse(b64ToUtf8(uri.slice(29)));
    else if (uri.startsWith("data:application/json,")) out = JSON.parse(decodeURIComponent(uri.slice(22)));
  } catch { out = {}; }
  if (!out || typeof out !== "object" || Array.isArray(out)) out = {};
  metaCache.set(uri, out);
  return out;
}

/* ───────────────────────────── wallet ───────────────────────────── */
const W = { address: null, chainId: null, wc: null };
const eth = () => window.ethereum;

// "Disconnected" is remembered so the site does not silently re-attach the wallet on reload.
const DISCONNECTED = "moralume.walletDisconnected";
const setDisconnected = (v) => { try { v ? localStorage.setItem(DISCONNECTED, "1") : localStorage.removeItem(DISCONNECTED); } catch {} };
const isDisconnected = () => { try { return localStorage.getItem(DISCONNECTED) === "1"; } catch { return false; } };

async function connect(pickAccount = false) {
  if (!eth()) {
    toast('No browser wallet found. Install <a href="https://metamask.io" target="_blank" rel="noopener noreferrer">MetaMask</a> or another EVM wallet.', "err", 9000);
    throw new Error("No wallet");
  }
  // After a disconnect (or on "Switch wallet") ask the wallet to show its account picker again.
  if (pickAccount || isDisconnected()) {
    try { await eth().request({ method: "wallet_requestPermissions", params: [{ eth_accounts: {} }] }); }
    catch (e) { if (e.code === 4001) throw e; /* wallet without this method: fall back below */ }
  }
  const [addr] = await eth().request({ method: "eth_requestAccounts" });
  if (!addr) throw new Error("No account selected in your wallet.");
  setDisconnected(false);
  W.address = getAddress(addr);
  W.chainId = Number(await eth().request({ method: "eth_chainId" }));
  W.wc = createWalletClient({ chain, transport: custom(eth()) });
  renderHeader();
  return W.address;
}
async function disconnect() {
  // Revoke this site's account permission where the wallet supports it (MetaMask does);
  // otherwise just forget the account locally.
  try { await eth()?.request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }); } catch {}
  setDisconnected(true);
  W.address = null; W.wc = null;
  closeWalletMenu();
  renderHeader(); render();
  toast("Wallet disconnected.");
}
async function ensureChain() {
  if (W.chainId === CHAIN_ID) return;
  try {
    await eth().request({ method: "wallet_switchEthereumChain", params: [{ chainId: toHex(CHAIN_ID) }] });
  } catch (e) {
    if (e.code === 4902 || /Unrecognized|not been added|unknown chain/i.test(e.message || "")) {
      await eth().request({ method: "wallet_addEthereumChain", params: [{
        chainId: toHex(CHAIN_ID), chainName: "GIWA Sepolia", nativeCurrency: D.chain.nativeCurrency,
        rpcUrls: [RPC], blockExplorerUrls: [EXPLORER],
      }] });
    } else throw e;
  }
  W.chainId = Number(await eth().request({ method: "eth_chainId" }));
  renderHeader();
  if (W.chainId !== CHAIN_ID) throw new Error("Please switch your wallet to GIWA Sepolia.");
}
async function ensureWallet() {
  if (!W.address) await connect();
  await ensureChain();
  return W.address;
}
if (eth()) {
  eth().on?.("accountsChanged", (a) => {
    if (isDisconnected()) return;
    W.address = a?.[0] ? getAddress(a[0]) : null;
    if (W.address && !W.wc) W.wc = createWalletClient({ chain, transport: custom(eth()) });
    renderHeader(); render();
  });
  eth().on?.("chainChanged", (c) => { W.chainId = Number(c); renderHeader(); });
  eth().request({ method: "eth_accounts" }).then(async (a) => {
    if (a?.[0] && !isDisconnected()) {
      W.address = getAddress(a[0]);
      W.chainId = Number(await eth().request({ method: "eth_chainId" }));
      W.wc = createWalletClient({ chain, transport: custom(eth()) });
      renderHeader(); render();
    }
  }).catch(() => {});
}

function renderHeader() {
  const f = $("#faucet");
  if (f) { const u = safeUrl(SITE.faucetUrl || ""); if (u) f.href = u; else f.remove(); }
  $("#brand").textContent = SITE.name;
  document.title = `${SITE.name} — Token launchpad on GIWA, powered by Ammora`;
  const btn = $("#connect");
  btn.textContent = W.address ? `${short(W.address)} ▾` : "Connect wallet";
  btn.className = W.address ? "btn ghost" : "btn dark";
  const net = $("#net");
  const wrong = W.address && W.chainId !== CHAIN_ID;
  net.className = "netpill" + (wrong ? " wrong" : "");
  net.textContent = wrong ? "Switch to GIWA Sepolia" : "GIWA Sepolia";
  const route = (location.hash.replace(/^#\/?/, "").split("/")[0]) || "";
  document.querySelectorAll(".links a").forEach((a) => a.classList.toggle("active", a.dataset.route === route));
}
// Connected: the address button opens a small menu (copy, explorer, switch wallet, disconnect).
function closeWalletMenu() { $("#wmenu")?.remove(); }
function openWalletMenu() {
  closeWalletMenu();
  const m = document.createElement("div");
  m.id = "wmenu";
  m.className = "wmenu";
  m.innerHTML = `<div class="wmenu-addr mono">${esc(W.address)}</div>
    <button data-a="earnings">My earnings</button>
    <button data-a="copy">Copy address</button>
    <button data-a="explorer">View on explorer ↗</button>
    <button data-a="switch">Switch wallet</button>
    <button data-a="disconnect" class="danger">Disconnect</button>`;
  document.body.appendChild(m);
  const r = $("#connect").getBoundingClientRect();
  m.style.top = `${r.bottom + 8}px`;
  m.style.right = `${Math.max(12, window.innerWidth - r.right)}px`;
  m.querySelectorAll("button").forEach((b) => (b.onclick = async () => {
    const act = b.dataset.a;
    if (act === "earnings") { closeWalletMenu(); location.hash = "#/earnings"; }
    if (act === "copy") { try { await navigator.clipboard.writeText(W.address); toast("Address copied."); } catch { toast("Could not copy.", "err"); } closeWalletMenu(); }
    if (act === "explorer") { window.open(addrUrl(W.address), "_blank", "noopener,noreferrer"); closeWalletMenu(); }
    if (act === "switch") { closeWalletMenu(); try { await connect(true); await ensureChain(); render(); } catch (e) { if (e.message !== "No wallet") toast(esc(errText(e)), "err"); } }
    if (act === "disconnect") await disconnect();
  }));
}
document.addEventListener("click", (e) => { if (!e.target.closest("#wmenu") && !e.target.closest("#connect")) closeWalletMenu(); });
window.addEventListener("hashchange", closeWalletMenu);

$("#connect").onclick = async () => {
  if (W.address) { $("#wmenu") ? closeWalletMenu() : openWalletMenu(); return; }
  try { await connect(); await ensureChain(); render(); } catch (e) { if (e.message !== "No wallet") toast(esc(errText(e)), "err"); }
};
$("#net").onclick = () => { if (W.address && W.chainId !== CHAIN_ID) ensureChain().catch((e) => toast(esc(errText(e)), "err")); };

/* ───────────────────────────── transactions ───────────────────────────── */
// Multi-step modal: every step is shown, run in order, and its result is reported.
function stepModal(title, steps) {
  const bg = document.createElement("div");
  bg.className = "modal-bg";
  bg.innerHTML = `<div class="modal"><h3>${esc(title)}</h3>
    <div class="txsteps">${steps.map((s, i) => `<div class="txstep" data-i="${i}"><i></i><span>${esc(s.label)}</span></div>`).join("")}</div>
    <div class="msg"></div><button class="btn ghost block close" style="display:none">Close</button></div>`;
  document.body.appendChild(bg);
  const close = () => bg.remove();
  $(".close", bg).onclick = close;
  return {
    async run() {
      const results = [];
      for (let i = 0; i < steps.length; i++) {
        const el = $(`.txstep[data-i="${i}"]`, bg);
        el.className = "txstep run";
        try {
          results.push(await steps[i].run(results));
          el.className = "txstep done"; $("i", el).textContent = "✓";
        } catch (e) {
          el.className = "txstep fail"; $("i", el).textContent = "!";
          $(".msg", bg).innerHTML = `<div class="alert err">${esc(errText(e))}</div>`;
          $(".close", bg).style.display = "block";
          throw e;
        }
      }
      setTimeout(close, 900);
      return results;
    },
    close,
    msg(html) { $(".msg", bg).innerHTML = html; },
  };
}

// Simulate against current state, ask the wallet to sign, wait for a successful receipt.
async function sendTx({ to, data, value = 0n }, label = "Transaction") {
  const account = W.address;
  // Simulate first so reverts surface before signing. Public RPC replicas can lag a few
  // seconds behind a just-confirmed approval/wrap, so retry briefly before giving up.
  for (let i = 0; ; i++) {
    try { await pc.call({ account, to, data, value }); break; }
    catch (e) { if (i >= 3 || e.code === 4001) throw e; await sleep(2500); }
  }
  const hash = await W.wc.sendTransaction({ account, chain, to, data, value });
  toast(`${esc(label)} sent · <a href="${txUrl(hash)}" target="_blank" rel="noopener">view</a>`);
  const receipt = await pc.waitForTransactionReceipt({ hash, pollingInterval: 1500, timeout: 180_000 });
  if (receipt.status !== "success") throw new Error(`${label} reverted (${hash})`);
  toast(`${esc(label)} confirmed · <a href="${txUrl(hash)}" target="_blank" rel="noopener">view</a>`, "ok");
  return receipt;
}
const balanceOf = (token, who) => pc.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [who] });
const allowance = (token, owner, spender) => pc.readContract({ address: token, abi: erc20Abi, functionName: "allowance", args: [owner, spender] });

// Builds the extra steps a trade needs: wrap ETH→WETH for the shortfall, exact-amount approvals.
async function prepSteps({ approvals = [], wethNeeded = 0n }) {
  const steps = [];
  if (wethNeeded > 0n) {
    const wbal = await balanceOf(WETH, W.address);
    if (wbal < wethNeeded) {
      const diff = wethNeeded - wbal;
      const ethBal = await pc.getBalance({ address: W.address });
      if (ethBal < diff) throw new Error(`Not enough ETH: need ${formatUnits(diff, 18)} more ETH to wrap (plus gas).`);
      steps.push({ label: `Wrap ${fmtUnits(diff, 18, 6).replace(/<[^>]+>/g, "")} ETH → WETH`, run: () => sendTx({ to: WETH, data: encodeFunctionData({ abi: wethAbi, functionName: "deposit" }), value: diff }, "Wrap ETH") });
    }
  }
  for (const a of approvals) {
    const cur = await allowance(a.token, W.address, a.spender);
    if (cur < a.amount) {
      steps.push({ label: `Approve exact amount`, run: () => sendTx({ to: a.token, data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [a.spender, a.amount] }) }, "Approval") });
    }
  }
  return steps;
}

/* ───────────────────────────── launch discovery ───────────────────────────── */
let launchCache = { at: 0, list: [] };

function decodeLaunchLog(l) {
  const ev = decodeEventLog({ abi: A.ammoraLaunchFactoryV4Abi, data: l.data, topics: l.topics.filter(Boolean) });
  return {
    token: getAddress(ev.args.token), curve: getAddress(ev.args.curve), creator: getAddress(ev.args.creator),
    configId: ev.args.configId, configHash: ev.args.configHash, metadataURI: ev.args.metadataURI,
    block: Number(l.blockNumber), time: l.timeStamp ? Number(l.timeStamp) : null, tx: l.transactionHash,
  };
}
// GIWA's Blockscout indexes the factory's LaunchCreated events (fast, full history).
async function explorerLogs(params) {
  const out = [];
  let from = params.fromBlock ?? FACTORY_START;
  for (let page = 0; page < 6; page++) {
    const q = new URLSearchParams({ module: "logs", action: "getLogs", fromBlock: String(from), toBlock: String(params.toBlock ?? "latest"), address: params.address, topic0: params.topic0 });
    if (params.topic2) { q.set("topic2", params.topic2); q.set("topic0_2_opr", "and"); }
    const c = new AbortController(); const t = setTimeout(() => c.abort(), 30000);
    const j = await fetch(`${EXPLORER}/api?${q}`, { signal: c.signal }).then((r) => r.json()).finally(() => clearTimeout(t));
    const res = Array.isArray(j.result) ? j.result : [];
    out.push(...res);
    if (res.length < 1000) break;
    from = Number(res[res.length - 1].blockNumber) + 1;
  }
  return out;
}
// Fallback: scan recent blocks directly over RPC (the public RPC limits ranges to 10k blocks).
async function rpcRecentLaunches(windows = 12) {
  const head = await pc.getBlockNumber();
  const out = [];
  for (let i = 0; i < windows; i++) {
    const to = head - BigInt(i * 10000);
    const from = to - 9999n;
    if (to < FACTORY_START) break;
    const logs = await pc.getLogs({ address: L.factory, event: LAUNCH_EVENT, fromBlock: from, toBlock: to });
    out.push(...logs.map((l) => ({ ...l, timeStamp: null })));
  }
  return out;
}
function localLaunches() {
  try { return JSON.parse(localStorage.getItem("moralume.created") || "[]"); } catch { return []; }
}
function rememberLaunch(x) {
  const list = localLaunches().filter((y) => y.curve !== x.curve);
  list.unshift(x);
  try { localStorage.setItem("moralume.created", bnJson(list.slice(0, 100))); } catch {}
}

// Decoded launches are cached in localStorage; later visits only fetch blocks after the cache.
const LOG_CACHE = "moralume.launchLogs.v1";
function readLogCache() {
  try { const c = JSON.parse(localStorage.getItem(LOG_CACHE) || "null"); if (c?.factory === L.factory) return c; } catch {}
  return { factory: L.factory, last: FACTORY_START - 1, items: [] };
}
async function fetchNewLaunchLogs() {
  const cache = readLogCache();
  const head = Number(await pc.getBlockNumber());
  const from = cache.last + 1;
  const ranges = [];
  for (let s = from; s <= head; s += 1_500_000) ranges.push([s, Math.min(head, s + 1_499_999)]);
  const settled = await Promise.allSettled(ranges.map(([a, b]) => explorerLogs({ address: L.factory, topic0: LAUNCH_TOPIC, fromBlock: a, toBlock: b })));
  const fresh = [];
  let ok = true;
  settled.forEach((r) => { if (r.status === "fulfilled") fresh.push(...r.value); else ok = false; });
  if (!ok && cache.items.length === 0 && fresh.length === 0) {
    try { fresh.push(...await rpcRecentLaunches()); } catch {}
  }
  const items = [...cache.items];
  for (const l of fresh) { try { const x = decodeLaunchLog(l); items.push({ ...x, configId: String(x.configId) }); } catch {} }
  if (ok) { try { localStorage.setItem(LOG_CACHE, JSON.stringify({ factory: L.factory, last: head, items })); } catch {} }
  return items.map((x) => ({ ...x, configId: BigInt(x.configId) }));
}

async function loadLaunches(force = false) {
  if (!force && Date.now() - launchCache.at < 30_000 && launchCache.list.length) return launchCache.list;
  const byCurve = new Map();
  for (const x of await fetchNewLaunchLogs()) byCurve.set(x.curve, x);
  for (const x of localLaunches()) if (!byCurve.has(x.curve)) byCurve.set(x.curve, { ...x, configId: BigInt(x.configId) });
  const list = [...byCurve.values()].sort((a, b) => b.block - a.block);
  await enrich(list);
  launchCache = { at: Date.now(), list };
  return list;
}

// One multicall batch reads every curve + token (status, price, reserves, names).
async function enrich(list) {
  const fnsCurve = ["status", "sqrtPrice", "quoteReserve", "migrationQuoteThreshold", "canonicalPool"];
  const fnsTok = ["name", "symbol", "decimals", "totalSupply"];
  const contracts = list.flatMap((x) => [
    ...fnsCurve.map((functionName) => ({ address: x.curve, abi: A.ammoraLaunchPoolV4Abi, functionName })),
    ...fnsTok.map((functionName) => ({ address: x.token, abi: erc20Abi, functionName })),
  ]);
  const per = fnsCurve.length + fnsTok.length;
  // Keep each multicall small: the public RPC rejects very large eth_call payloads.
  const chunks = [];
  for (let i = 0; i < contracts.length; i += 250) chunks.push(contracts.slice(i, i + 250));
  const results = (await Promise.all(chunks.map((c) => pc.multicall({ contracts: c, allowFailure: true })))).flat();
  list.forEach((x, i) => {
    const r = results.slice(i * per, (i + 1) * per).map((y) => (y.status === "success" ? y.result : undefined));
    [x.status, x.sqrtPrice, x.quoteReserve, x.threshold, x.pool, x.name, x.symbol, x.decimals, x.supply] = r;
    x.decimals = Number(x.decimals ?? 9);
    x.price = x.sqrtPrice ? sqrtToPrice(x.sqrtPrice, x.decimals) : 0;
    x.mcap = x.supply ? x.price * Number(formatUnits(x.supply, x.decimals)) : 0;
    x.progress = x.status >= 2 ? 1 : x.threshold ? Math.min(1, Number(x.quoteReserve ?? 0n) / Number(x.threshold)) : 0;
  });
  await Promise.all(list.map(async (x) => {
    if (x.metadataURI?.startsWith("data:")) x.meta = await readMetadata(x.metadataURI);
  }));
}

const statusBadge = (s) => s === 1 ? `<span class="badge b-live">Live</span>`
  : s === 2 ? `<span class="badge b-ready">Graduating</span>`
  : s === 3 ? `<span class="badge b-grad">Graduated</span>` : `<span class="badge b-off">Inactive</span>`;
const avatar = (x, cls = "") => {
  const img = safeImg(x.meta?.image);
  const letter = (String(x.symbol || x.meta?.symbol || "?").slice(0, 1).toUpperCase().match(/[A-Z0-9]/) || ["?"])[0];
  return img ? `<img class="avatar ${cls}" src="${esc(img)}" alt="" loading="lazy" data-letter="${letter}">`
    : `<div class="avatar ${cls}">${letter}</div>`;
};
// Broken avatar images fall back to the letter badge (no inline onerror handlers, so the CSP stays strict).
document.addEventListener("error", (e) => {
  const t = e.target;
  if (t instanceof HTMLImageElement && t.classList.contains("avatar")) {
    const d = document.createElement("div");
    d.className = t.className;
    d.textContent = t.dataset.letter || "?";
    t.replaceWith(d);
  }
}, true);

/* ───────────────────────────── views: explore ───────────────────────────── */
const ui = { tab: "site", q: "" };
let renderId = 0;

async function viewExplore(id) {
  app.innerHTML = `
  <section class="hero">
    <span class="chip">🌙 Built with the Ammora SDK on GIWA</span>
    <h1>Launch gently. Grow on a bonding curve. Graduate into real liquidity.</h1>
    <p>${esc(SITE.tagline)} Every token gets an Ammora ALC bonding curve; when the curve fills, it migrates into a permanent ARL liquidity pool.</p>
    <div style="display:flex;gap:10px;flex-wrap:wrap"><a class="btn grad" href="#/create">Launch a token</a><a class="btn ghost" href="#/swap">Swap tokens</a></div>
    <div class="stats" id="stats">${[1, 2, 3, 4].map(() => `<div class="stat"><div class="k skel" style="height:12px;width:60%"></div><div class="v skel" style="height:24px;margin-top:8px"></div></div>`).join("")}</div>
  </section>
  <div class="toolbar">
    <div class="tabs" id="tabs">
      ${[["site", "This launchpad"], ["all", "All Ammora"], ["live", "Live"], ["ready", "Graduating"], ["grad", "Graduated"], ["mine", "Mine"]]
        .map(([k, t]) => `<button data-k="${k}" class="${ui.tab === k ? "on" : ""}">${t}</button>`).join("")}
    </div>
    <input class="search" id="q" placeholder="Search name, symbol or address" value="${esc(ui.q)}" />
    <button class="btn ghost small" id="refresh">Refresh</button>
  </div>
  <div class="grid" id="grid">${Array.from({ length: 6 }, () => `<div class="card lcard"><div class="skel" style="height:48px"></div><div class="skel" style="height:34px"></div><div class="skel" style="height:8px"></div></div>`).join("")}</div>`;

  let list = [];
  const draw = () => {
    if (id !== renderId) return;
    const cfg = siteConfigId();
    const q = ui.q.trim().toLowerCase();
    let rows = list.filter((x) => x.status !== undefined && !isHidden(x.token, x.curve));
    if (ui.tab === "site") rows = rows.filter((x) => x.configId === cfg);
    if (ui.tab === "live") rows = rows.filter((x) => x.status === 1);
    if (ui.tab === "ready") rows = rows.filter((x) => x.status === 2);
    if (ui.tab === "grad") rows = rows.filter((x) => x.status === 3);
    if (ui.tab === "mine") rows = W.address ? rows.filter((x) => x.creator === W.address) : [];
    if (q) rows = rows.filter((x) => [x.name, x.symbol, x.token, x.curve, x.meta?.name].some((s) => String(s || "").toLowerCase().includes(q)));
    const g = $("#grid");
    if (!rows.length) {
      g.innerHTML = `<div class="empty">${ui.tab === "site" ? `No tokens on this launchpad's Config #${cfg} yet. <a href="#/create">Launch the first one →</a>` : ui.tab === "mine" && !W.address ? "Connect your wallet to see your launches." : "Nothing here yet."}</div>`;
      return;
    }
    rows = [...rows.filter(isOfficial), ...rows.filter((x) => !isOfficial(x))];
    g.innerHTML = rows.slice(0, 120).map((x) => `
      <a class="card lcard" href="#/token/${x.curve}">
        <div class="lhead">${avatar(x)}
          <div style="min-width:0;flex:1"><div class="lname">${esc(x.name || x.meta?.name || "Unnamed")}</div><div class="lsym">$${esc(x.symbol || x.meta?.symbol || "")} ${officialBadge(x)}</div></div>
          <div style="display:grid;gap:4px;justify-items:end">${statusBadge(x.status)}${x.configId === cfg ? `<span class="badge b-site">${esc(SITE.name)}</span>` : ""}</div>
        </div>
        <div class="ldesc">${esc(x.meta?.description || `Created by ${short(x.creator)} · Config #${x.configId}`)}</div>
        <div class="row"><span class="muted">Market cap</span><b>${fmtNum(x.mcap)} ETH</b></div>
        <div><div class="row" style="margin-bottom:6px"><span class="muted">Bonding curve</span><b>${(x.progress * 100).toFixed(1)}%</b></div><div class="bar"><i style="width:${(x.progress * 100).toFixed(1)}%"></i></div></div>
        <div class="row muted"><span>${x.time ? timeAgo(x.time) : `block ${x.block}`}</span><span>by ${short(x.creator)}</span></div>
      </a>`).join("");
  };
  const bind = () => {
    document.querySelectorAll("#tabs button").forEach((b) => (b.onclick = () => { ui.tab = b.dataset.k; document.querySelectorAll("#tabs button").forEach((y) => y.classList.toggle("on", y === b)); draw(); }));
    $("#q").oninput = (e) => { ui.q = e.target.value; draw(); };
    $("#refresh").onclick = async () => { $("#refresh").disabled = true; try { list = await loadLaunches(true); stats(); draw(); } finally { $("#refresh").disabled = false; } };
  };
  const stats = () => {
    if (id !== renderId) return;
    const visible = list.filter((x) => !isHidden(x.token, x.curve));
    const live = visible.filter((x) => x.status === 1).length;
    const grad = visible.filter((x) => x.status === 3).length;
    const tvl = visible.filter((x) => x.status === 1).reduce((s, x) => s + Number(formatUnits(x.quoteReserve ?? 0n, 18)), 0);
    const site = list.filter((x) => x.configId === siteConfigId()).length;
    $("#stats").innerHTML = [["Ammora launches", visible.length], ["Live curves", live], ["Graduated", grad], ["WETH in curves", fmtNum(tvl)], ["On " + SITE.name, site]]
      .slice(0, 4).map(([k, v]) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${v}</div></div>`).join("");
  };
  bind();
  try {
    list = await loadLaunches();
    if (ui.tab === "site" && !list.some((x) => x.configId === siteConfigId())) ui.tab = "all";
    if (id !== renderId) return;
    document.querySelectorAll("#tabs button").forEach((y) => y.classList.toggle("on", y.dataset.k === ui.tab));
    stats(); draw();
  } catch (e) {
    if (id === renderId) $("#grid").innerHTML = `<div class="empty">Could not load launches: ${esc(errText(e))}</div>`;
  }
}

/* ───────────────────────────── views: token page ───────────────────────────── */
let swapClientPromise = null;
const swapClient = () => (swapClientPromise ??= A.AmmoraSwapClient.create(pc, {
  deploymentCatalog: { [CHAIN_ID]: D }, factoryProfiles: A.giwaSepoliaAutoRoutePoolProfiles,
}));

async function launchInfo(curve) {
  const cached = launchCache.list.find((x) => x.curve === curve);
  if (cached) return cached;
  const local = localLaunches().find((x) => x.curve === curve);
  if (local) return { ...local, configId: BigInt(local.configId) };
  try {
    const logs = await explorerLogs({ address: L.factory, topic0: LAUNCH_TOPIC, topic2: "0x" + curve.slice(2).toLowerCase().padStart(64, "0") });
    if (logs[0]) return decodeLaunchLog(logs[0]);
  } catch {}
  return null;
}

async function viewToken(id, curveParam) {
  if (!isAddress(curveParam)) { app.innerHTML = `<div class="empty">Invalid curve address.</div>`; return; }
  const curve = getAddress(curveParam);
  app.innerHTML = `<div class="tpage"><div class="card panel"><div class="skel" style="height:72px"></div><div class="skel" style="height:220px;margin-top:16px"></div></div><div class="card trade"><div class="skel" style="height:300px"></div></div></div>`;
  const cc = new A.AmmoraV4LaunchCurveClient(pc, curve, CORE);
  let st, info, tok, meta = {}, trades = [], cfgEntry = null;
  try {
    let bn;
    // A freshly created curve can take a few seconds to appear on lagging RPC replicas.
    for (let i = 0; ; i++) {
      bn = await pc.getBlockNumber();
      try { [st, info] = await Promise.all([cc.getStateAtBlock(bn), launchInfo(curve)]); break; }
      catch (e) { if (i >= 4) throw e; await sleep(2500); }
    }
    // Authenticate: the curve must be registered by the reviewed V4 factory for this base token.
    const factoryToken = await pc.readContract({ address: L.factory, abi: A.ammoraLaunchFactoryV4Abi, functionName: "tokenForCurve", args: [curve] });
    if (factoryToken === zeroAddress || factoryToken.toLowerCase() !== st.baseToken.toLowerCase()) throw new Error("This address is not a curve created by the Ammora V4 launch factory.");
    const [name, symbol, decimals, supply] = await Promise.all(["name", "symbol", "decimals", "totalSupply"].map((functionName) => pc.readContract({ address: st.baseToken, abi: erc20Abi, functionName })));
    tok = { name, symbol, decimals: Number(decimals), supply };
    meta = info?.metadataURI ? await readMetadata(info.metadataURI) : {};
    try { cfgEntry = await A.getAmmoraV4ConfigAtBlock(pc, L.configRegistry, st.configId, bn); } catch {}
  } catch (e) {
    if (id === renderId) app.innerHTML = `<div class="formcard card"><h2>Launch not found</h2><div class="alert err">${esc(errText(e))}</div><a class="btn ghost" href="#/">← Back to explore</a></div>`;
    return;
  }
  if (id !== renderId) return;
  if (isHidden(curve, st.baseToken)) {
    app.innerHTML = `<div class="formcard card"><h2>Token unavailable</h2><div class="alert warn">This token has been hidden on ${esc(SITE.name)}.</div><a class="btn ghost" href="#/">← Back to explore</a></div>`;
    return;
  }
  try {
    const logs = await explorerLogs({ address: curve, topic0: SWAP_TOPIC, fromBlock: info?.block ?? FACTORY_START });
    trades = logs.map((l) => {
      const ev = decodeEventLog({ abi: A.ammoraLaunchPoolV4Abi, data: l.data, topics: l.topics.filter(Boolean) });
      return { ...ev.args, time: Number(l.timeStamp), tx: l.transactionHash, block: Number(l.blockNumber) };
    });
  } catch {}
  if (id !== renderId) return;

  const dec = tok.decimals;
  const price = sqrtToPrice(st.sqrtPrice, dec);
  const mcap = price * Number(formatUnits(tok.supply, dec));
  const progress = st.status >= 2 ? 1 : Number(st.quoteReserve) / Number(st.migrationQuoteThreshold || 1n);
  const links = [["Website", meta.website], ["X", meta.twitter], ["Telegram", meta.telegram]].filter(([, u]) => safeUrl(u));
  const x = { meta, symbol: tok.symbol };

  app.innerHTML = `
  <div style="margin-top:18px"><a href="#/" class="muted">← All launches</a></div>
  <div class="tpage" style="margin-top:12px">
    <div>
      <div class="card panel">
        <div class="thead">${avatar(x, "lg")}
          <div style="flex:1;min-width:0"><h2>${esc(tok.name)} <span class="muted" style="font-size:18px">$${esc(tok.symbol)}</span> ${officialBadge({ token: st.baseToken, curve, creator: info?.creator || st.creator })}</h2>
          <div style="display:flex;gap:6px;align-items:center;margin-top:4px;flex-wrap:wrap">${statusBadge(st.status)}${st.configId === siteConfigId() ? `<span class="badge b-site">${esc(SITE.name)}</span>` : ""}<span class="muted" style="font-size:13px">Config #${st.configId} · fee ${(st.currentFeeBps / 100).toFixed(2)}%</span></div></div>
        </div>
        ${meta.description ? `<p class="ink2" style="margin:14px 0 0;white-space:pre-wrap">${esc(meta.description)}</p>` : ""}
        ${links.length ? `<div style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">${links.map(([t, u]) => `<a class="btn ghost small" href="${esc(safeUrl(u))}" target="_blank" rel="noopener noreferrer nofollow">${t} ↗</a>`).join("")}</div>` : ""}
        <div class="kv">
          <div><div class="k">Price</div><div class="v">${fmtNum(price)} ETH</div></div>
          <div><div class="k">Market cap</div><div class="v">${fmtNum(mcap)} ETH</div></div>
          <div><div class="k">Curve reserve</div><div class="v">${fmtUnits(st.quoteReserve, 18)} WETH</div></div>
          <div><div class="k">Trades</div><div class="v">${trades.length}</div></div>
        </div>
        <div style="margin-top:16px">
          <div class="row" style="margin-bottom:6px"><span class="muted">Bonding curve progress — graduates at ${fmtUnits(st.migrationQuoteThreshold, 18)} WETH</span><b>${(Math.min(1, progress) * 100).toFixed(2)}%</b></div>
          <div class="bar" style="height:12px"><i style="width:${(Math.min(1, progress) * 100).toFixed(2)}%"></i></div>
        </div>
        <svg class="chart" id="chart" viewBox="0 0 700 220" preserveAspectRatio="none"></svg>
        <div class="addr">
          <div><span>Token</span> <a class="mono" href="${addrUrl(st.baseToken)}" target="_blank" rel="noopener">${short(st.baseToken)}</a></div>
          <div><span>Curve</span> <a class="mono" href="${addrUrl(curve)}" target="_blank" rel="noopener">${short(curve)}</a></div>
          <div><span>Creator</span> <a class="mono" href="${addrUrl(st.creator)}" target="_blank" rel="noopener">${short(st.creator)}</a></div>
          ${st.canonicalPool !== zeroAddress ? `<div><span>ARL pool</span> <a class="mono" href="${addrUrl(st.canonicalPool)}" target="_blank" rel="noopener">${short(st.canonicalPool)}</a></div>` : ""}
          <div><span>Partner</span> <a class="mono" href="${addrUrl(st.partnerRecipient)}" target="_blank" rel="noopener">${short(st.partnerRecipient)}</a></div>
        </div>
      </div>
      <div class="card panel" style="margin-top:14px">
        <div class="sect" style="margin-top:0">Bonding-curve trades</div>
        ${trades.length ? `<div style="overflow:auto"><table><thead><tr><th>Type</th><th>Paid</th><th>Received</th><th>Trader</th><th>When</th></tr></thead><tbody>
          ${trades.slice(-40).reverse().map((t) => {
            const sell = t.baseForQuote;
            return `<tr><td><b class="${sell ? "bad" : "good"}">${sell ? "Sell" : "Buy"}</b></td>
              <td>${sell ? fmtUnits(t.amountIn, dec) + " " + esc(tok.symbol) : fmtUnits(t.amountIn, 18) + " WETH"}</td>
              <td>${sell ? fmtUnits(t.amountOut, 18) + " WETH" : fmtUnits(t.amountOut, dec) + " " + esc(tok.symbol)}</td>
              <td><a class="mono" href="${addrUrl(t.trader)}" target="_blank" rel="noopener">${short(t.trader)}</a></td>
              <td><a href="${txUrl(t.tx)}" target="_blank" rel="noopener">${timeAgo(t.time)}</a></td></tr>`;
          }).join("")}</tbody></table></div>` : `<div class="muted">No curve trades yet — be the first buyer.</div>`}
      </div>
    </div>
    <div class="card trade" id="trade"></div>
  </div>`;
  drawChart(trades, dec, cfgEntry);
  const ctx = { cc, st, tok, curve, cfgEntry, refresh: () => { launchCache.at = 0; setTimeout(render, 2500); } };
  if (st.status === 1) tradeCurve(ctx);
  else if (st.status === 2) tradeMigrate(ctx);
  else if (st.status === 3) tradePool(ctx);
  else $("#trade").innerHTML = `<div class="alert warn">This curve is not active yet.</div>`;
}

function drawChart(trades, dec) {
  const svg = $("#chart");
  if (!svg) return;
  const pts = trades.map((t) => ({ t: t.time, p: sqrtToPrice(t.nextSqrtPrice, dec) })).filter((x) => x.p > 0);
  if (pts.length < 2) {
    svg.innerHTML = `<text x="350" y="115" text-anchor="middle" fill="#8a90a6" font-size="14">Price chart appears after a couple of trades</text>`;
    return;
  }
  const W_ = 700, H = 220, pad = 14;
  const ps = pts.map((x) => x.p), min = Math.min(...ps), max = Math.max(...ps);
  const xs = (i) => pad + (i / (pts.length - 1)) * (W_ - 2 * pad);
  const ys = (p) => H - pad - ((p - min) / (max - min || 1)) * (H - 2 * pad);
  const line = pts.map((x, i) => `${i ? "L" : "M"}${xs(i).toFixed(1)},${ys(x.p).toFixed(1)}`).join("");
  svg.innerHTML = `<defs><linearGradient id="lg" x1="0" x2="1"><stop offset="0" stop-color="#e8836b"/><stop offset="1" stop-color="#f3b88a"/></linearGradient>
    <linearGradient id="fg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#e8836b" stop-opacity=".18"/><stop offset="1" stop-color="#e8836b" stop-opacity="0"/></linearGradient></defs>
    <path d="${line}L${xs(pts.length - 1)},${H - pad}L${pad},${H - pad}Z" fill="url(#fg)"/>
    <path d="${line}" fill="none" stroke="url(#lg)" stroke-width="2.5" vector-effect="non-scaling-stroke"/>`;
}

// Shared trade-box shell (buy/sell tabs, amount input, quick buttons, live quote).
function tradeBox(ctx, { title, quoteFn, execFn, note }) {
  const box = $("#trade");
  const st = { side: "buy", slip: SITE.defaultSlippageBps, quote: null, seq: 0 };
  const sym = ctx.tok.symbol;
  const draw = () => {
    const buy = st.side === "buy";
    box.innerHTML = `
      <div style="font-weight:800;margin-bottom:10px">${title}</div>
      <div class="seg"><button class="buy ${buy ? "on" : ""}" data-s="buy">Buy</button><button class="sell ${!buy ? "on" : ""}" data-s="sell">Sell</button></div>
      <div class="field"><div class="top"><span>You pay</span><span id="bal">${W.address ? "Balance: …" : ""}</span></div>
        <div class="mid"><input id="amt" inputmode="decimal" placeholder="0.0" autocomplete="off"/><span class="tok">${buy ? "ETH/WETH" : esc(sym)}</span></div></div>
      <div class="quick">${(buy ? ["0.0001", "0.001", "0.005", "0.01"] : ["25%", "50%", "75%", "100%"]).map((v) => `<button data-v="${v}">${v}</button>`).join("")}</div>
      <div class="quote" id="qbox"><div class="row"><span class="muted">You receive (est.)</span><b id="qout">—</b></div>
        <div class="row"><span class="muted">Minimum after <span id="slipLbl">${(st.slip / 100).toFixed(1)}</span>% slippage</span><span id="qmin">—</span></div>
        <div class="row"><span class="muted">Fee</span><span id="qfee">—</span></div></div>
      <div id="qnote"></div>
      <button class="btn block ${buy ? "grad" : ""}" id="go">${W.address ? (buy ? `Buy $${esc(sym)}` : `Sell $${esc(sym)}`) : "Connect wallet"}</button>
      <div class="note">${note}</div>
      <div class="row note"><span>Slippage</span><span><select id="slip" class="inp" style="padding:4px 8px;width:auto">${[50, 100, 300, 500, 1000].map((b) => `<option value="${b}" ${b === st.slip ? "selected" : ""}>${b / 100}%</option>`).join("")}</select></span></div>`;
    box.querySelectorAll(".seg button").forEach((b) => (b.onclick = () => { st.side = b.dataset.s; draw(); }));
    $("#slip").onchange = (e) => { st.slip = Number(e.target.value); $("#slipLbl").textContent = (st.slip / 100).toFixed(1); requote(); };
    $("#amt").oninput = () => requote();
    box.querySelectorAll(".quick button").forEach((b) => (b.onclick = async () => {
      const v = b.dataset.v;
      if (v.endsWith("%")) {
        if (!W.address) return;
        const bal = await balanceOf(ctx.st.baseToken, W.address);
        $("#amt").value = formatUnits(bal * BigInt(parseInt(v)) / 100n, ctx.tok.decimals);
      } else $("#amt").value = v;
      requote();
    }));
    $("#go").onclick = go;
    showBal();
    const pre = sessionStorage.getItem("moralume.prefillBuy");
    if (pre && buy) { sessionStorage.removeItem("moralume.prefillBuy"); $("#amt").value = pre; requote(); }
  };
  const showBal = async () => {
    if (!W.address) return;
    try {
      if (st.side === "buy") {
        const [e, w] = await Promise.all([pc.getBalance({ address: W.address }), balanceOf(WETH, W.address)]);
        $("#bal").textContent = `${Number(formatUnits(e, 18)).toFixed(5)} ETH · ${Number(formatUnits(w, 18)).toFixed(5)} WETH`;
      } else {
        const b = await balanceOf(ctx.st.baseToken, W.address);
        $("#bal").innerHTML = `Balance: ${fmtUnits(b, ctx.tok.decimals)}`;
      }
    } catch {}
  };
  const parseAmt = () => {
    const v = ($("#amt")?.value || "").trim();
    if (!/^\d*\.?\d+$/.test(v)) return 0n;
    try { return parseUnits(v, st.side === "buy" ? 18 : ctx.tok.decimals); } catch { return 0n; }
  };
  let timer;
  const requote = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const amt = parseAmt();
      const my = ++st.seq;
      st.quote = null;
      if (!amt) { $("#qout").textContent = "—"; $("#qmin").textContent = "—"; $("#qfee").textContent = "—"; $("#qnote").innerHTML = ""; return; }
      $("#qout").textContent = "Quoting…";
      try {
        const q = await quoteFn(st.side, amt, st.slip);
        if (my !== st.seq) return;
        st.quote = q;
        const outDec = st.side === "buy" ? ctx.tok.decimals : 18, outSym = st.side === "buy" ? sym : "WETH";
        const feeDec = q.feeIsQuote ?? true ? 18 : ctx.tok.decimals;
        $("#qout").innerHTML = `${fmtUnits(q.amountOut, outDec)} ${esc(outSym)}`;
        $("#qmin").innerHTML = `${fmtUnits(q.minOut, outDec)} ${esc(outSym)}`;
        $("#qfee").innerHTML = `${fmtUnits(q.fee, feeDec)} ${q.feeIsQuote ?? true ? "WETH" : esc(sym)}`;
        $("#qnote").innerHTML = q.note || "";
      } catch (e) {
        if (my !== st.seq) return;
        $("#qout").textContent = "—";
        $("#qnote").innerHTML = `<div class="alert err">${esc(errText(e))}</div>`;
      }
    }, 350);
  };
  async function go() {
    try {
      await ensureWallet();
      if (!$("#amt")) return draw();
      const amt = parseAmt();
      if (!amt) throw new Error("Enter an amount.");
      if (st.side === "sell") {
        const bal = await balanceOf(ctx.st.baseToken, W.address);
        if (bal < amt) throw new Error(`Insufficient ${sym} balance.`);
      }
      $("#go").disabled = true;
      await execFn(st.side, amt, st.slip);
      ctx.refresh();
    } catch (e) {
      if (e.message !== "No wallet") toast(esc(errText(e)), "err", 9000);
    } finally { const g = $("#go"); if (g) g.disabled = false; showBal(); }
  }
  draw();
}

// ── Trade engines ───────────────────────────────────────────────────────────
// An engine quotes and builds the transaction steps for one token against WETH:
// "buy" = WETH → token, "sell" = token → WETH. The token page and the Swap page share them.

// Pre-graduation: the Ammora ALC bonding curve.
function curveEngine(ctx) {
  const { cc } = ctx;
  const quote = async (side, amt, slip) => {
    const baseForQuote = side === "sell";
    const bn = await pc.getBlockNumber();
    const q = await cc.quoteExactInputAtBlock(amt, baseForQuote, bn);
    const fill = A.classifyAmmoraV4ExactInputFill(q, baseForQuote);
    let note = "";
    if (fill.kind === "graduation-boundary") note = `<div class="alert info">This buy completes the bonding curve 🎓 Only ${fmtUnits(fill.consumedAmountIn, 18)} WETH is used; the unused ${fmtUnits(fill.refundableAmountIn, 18)} WETH stays in your wallet. After it confirms, anyone can migrate the curve into its ARL pool.</div>`;
    else if (fill.kind !== "full") throw new Error(baseForQuote ? "This sell cannot be filled in full on the curve. Try a smaller amount." : "This order cannot be filled. Try a smaller amount.");
    return { amountOut: q.amountOut, minOut: q.amountOut * BigInt(10_000 - slip) / 10_000n, fee: q.fee, feeIsQuote: true, note, fill };
  };
  const buildSteps = async (side, amt, slip) => {
    const baseForQuote = side === "sell";
    const bn = await pc.getBlockNumber();
    const q = await cc.quoteExactInputAtBlock(amt, baseForQuote, bn);
    const fill = A.classifyAmmoraV4ExactInputFill(q, baseForQuote);
    if (fill.kind !== "full" && fill.kind !== "graduation-boundary") throw new Error(`Order not executable (${fill.kind}).`);
    if (baseForQuote && fill.kind !== "full") throw new Error("Partial sells are not allowed. Try a smaller amount.");
    const plan = await cc.planSwapExactInput({
      includedAmountIn: amt, baseForQuote, allowPartialFill: fill.allowPartialFill, slippageBps: slip,
      recipient: W.address, deadline: nowSec() + 1200n,
    });
    const steps = await prepSteps({ approvals: plan.approvalRequirements, wethNeeded: baseForQuote ? 0n : amt });
    steps.push({ label: baseForQuote ? `Sell ${ctx.tok.symbol} on the curve` : `Buy ${ctx.tok.symbol} on the curve`, run: async () => {
      // Re-plan right before signing so minimum output reflects the latest state.
      const fresh = await cc.planSwapExactInput({ includedAmountIn: amt, baseForQuote, allowPartialFill: fill.allowPartialFill, slippageBps: slip, recipient: W.address, deadline: nowSec() + 1200n });
      return sendTx(fresh.transaction, baseForQuote ? "Sell" : "Buy");
    } });
    return steps;
  };
  return { route: "bonding curve", quote, buildSteps };
}

// Post-graduation: the canonical Ammora ARL pool through AmmoraSwapClient.
function poolEngine(ctx) {
  const model = ctx.cfgEntry?.config?.migrationMode === 1 ? "compounding" : "concentrated";
  const pool = ctx.st.canonicalPool;
  const prepare = async (side, amt, slip) => {
    const sw = await swapClient();
    return sw.prepareExactIn({
      model, pool, tokenIn: side === "buy" ? WETH : ctx.st.baseToken, inputAsset: "erc20", amountIn: amt,
      payer: W.address || ctx.st.creator, recipient: W.address || ctx.st.creator, slippageBps: slip, executionMode: "direct-wallet",
    });
  };
  const quote = async (side, amt, slip) => {
    const p = await prepare(side, amt, slip);
    const q = p.quote;
    const impact = q.priceImpactBps != null ? Number(q.priceImpactBps) / 100 : null;
    return {
      amountOut: q.expectedAmountOut, minOut: q.minimumAmountOut, fee: q.feeAmount ?? 0n,
      feeIsQuote: !q.feeToken || q.feeToken.toLowerCase() === WETH.toLowerCase(),
      note: impact != null && impact > 5 ? `<div class="alert warn">High price impact: ${impact.toFixed(2)}%</div>` : "",
    };
  };
  const buildSteps = async (side, amt, slip) => {
    const p = await prepare(side, amt, slip);
    if (p.quote.remainderAmountIn && p.quote.remainderAmountIn > 0n) throw new Error("The pool cannot fill this amount. Try a smaller trade.");
    const steps = await prepSteps({ approvals: p.approvalRequirements, wethNeeded: side === "buy" ? amt : 0n });
    steps.push({ label: side === "buy" ? `Buy ${ctx.tok.symbol} in ARL pool` : `Sell ${ctx.tok.symbol} in ARL pool`, run: async () => {
      const fresh = await prepare(side, amt, slip);
      return sendTx({ to: fresh.transaction.to, data: fresh.transaction.data, value: fresh.transaction.value ?? 0n }, "Swap");
    } });
    return steps;
  };
  return { route: `${model} ARL pool`, model, pool, quote, buildSteps };
}

const engineFor = (ctx) => (ctx.st.status === 1 ? curveEngine(ctx) : ctx.st.status === 3 ? poolEngine(ctx) : null);

function tradeCurve(ctx) {
  const e = curveEngine(ctx);
  tradeBox(ctx, {
    title: "Trade on the bonding curve", quoteFn: e.quote,
    execFn: async (side, amt, slip) => stepModal(side === "sell" ? "Selling" : "Buying", await e.buildSteps(side, amt, slip)).run(),
    note: "Buys are paid in WETH; any missing WETH is wrapped from your ETH automatically. Approvals are for the exact amount only.",
  });
}

// Curve filled: anyone can trigger migration into the ARL pool.
function tradeMigrate(ctx) {
  $("#trade").innerHTML = `
    <div style="font-weight:800;margin-bottom:10px">Graduation 🎓</div>
    <div class="alert info">The bonding curve is full. One permissionless transaction migrates its liquidity into a permanent Ammora ARL pool; trading continues there.</div>
    <button class="btn grad block" id="mig">${W.address ? "Migrate to ARL pool" : "Connect wallet to migrate"}</button>
    <div class="note">Gas only — no tokens are spent. The SDK checks the curve is authentic and ready before building the transaction.</div>`;
  $("#mig").onclick = async () => {
    try {
      await ensureWallet();
      $("#mig").disabled = true;
      await stepModal("Graduating", [{ label: "Migrate curve → ARL pool", run: async () => {
        const plan = await ctx.cc.planMigrateAtBlock(await pc.getBlockNumber());
        return sendTx(plan.transaction, "Migration");
      } }]).run();
      ctx.refresh();
    } catch (e) { toast(esc(errText(e)), "err", 9000); $("#mig").disabled = false; }
  };
}

function tradePool(ctx) {
  const e = poolEngine(ctx);
  tradeBox(ctx, {
    title: `Trade in the graduated ${e.model} ARL pool`, quoteFn: e.quote,
    execFn: async (side, amt, slip) => stepModal("Swapping", await e.buildSteps(side, amt, slip)).run(),
    note: `This token graduated. Trades route through the canonical Ammora ARL pool <a class="mono" href="${addrUrl(e.pool)}" target="_blank" rel="noopener">${short(e.pool)}</a>.`,
  });
}

/* ───────────────────────────── views: swap (exchange) ───────────────────────────── */
// Swap ETH/WETH ⇄ any Ammora launch token, or token ⇄ token routed through WETH.
// Each leg uses the token's live venue: the bonding curve before graduation, its ARL pool after.
const ETH_ASSET = { kind: "eth", symbol: "ETH", name: "Ether (auto-wrapped to WETH)", decimals: 18 };
const swapState = { from: ETH_ASSET, to: null, slip: SITE.defaultSlippageBps };
const tradeCtxCache = new Map();

async function loadTradeCtx(curve) {
  if (tradeCtxCache.has(curve) && Date.now() - tradeCtxCache.get(curve).at < 15_000) return tradeCtxCache.get(curve);
  const cc = new A.AmmoraV4LaunchCurveClient(pc, curve, CORE);
  const bn = await pc.getBlockNumber();
  const st = await cc.getStateAtBlock(bn);
  const factoryToken = await pc.readContract({ address: L.factory, abi: A.ammoraLaunchFactoryV4Abi, functionName: "tokenForCurve", args: [curve] });
  if (factoryToken === zeroAddress || factoryToken.toLowerCase() !== st.baseToken.toLowerCase()) throw new Error("Not an Ammora V4 launch.");
  const [name, symbol, decimals] = await Promise.all(["name", "symbol", "decimals"].map((functionName) => pc.readContract({ address: st.baseToken, abi: erc20Abi, functionName })));
  let cfgEntry = null;
  if (st.status === 3) { try { cfgEntry = await A.getAmmoraV4ConfigAtBlock(pc, L.configRegistry, st.configId, bn); } catch {} }
  const ctx = { at: Date.now(), cc, st, curve, cfgEntry, tok: { name, symbol, decimals: Number(decimals) } };
  tradeCtxCache.set(curve, ctx);
  return ctx;
}
const assetFromLaunch = (x) => ({ kind: "token", curve: x.curve, token: x.token, creator: x.creator, symbol: x.symbol || x.meta?.symbol || "?", name: x.name || x.meta?.name || "Unnamed", decimals: x.decimals ?? 9, meta: x.meta, status: x.status });
const assetLabel = (a) => a ? (a.kind === "eth" ? `<div class="avatar sm eth">Ξ</div><b>ETH</b>` : `${avatar(a, "sm")}<b>${esc(a.symbol)}</b>`) : `<b>Select token</b>`;

async function viewSwap(id, preselect) {
  app.innerHTML = `
  <div class="formcard card swapcard">
    <span class="chip">⇄ Exchange</span>
    <h2 style="margin-top:12px">Swap</h2>
    <div class="muted">Swap ETH and any Ammora launch on GIWA. Each trade routes through the token's bonding curve or, after graduation, its Ammora ARL pool.</div>
    <div class="field" style="margin-top:18px"><div class="top"><span>You pay</span><span id="sbalFrom"></span></div>
      <div class="mid"><input id="samt" inputmode="decimal" placeholder="0.0" autocomplete="off"/><button class="assetbtn" id="pickFrom"></button></div></div>
    <div style="display:flex;justify-content:center;margin:-6px 0"><button class="flip" id="flip" title="Switch direction">⇅</button></div>
    <div class="field"><div class="top"><span>You receive (est.)</span><span id="sbalTo"></span></div>
      <div class="mid"><input id="sout" placeholder="0.0" readonly tabindex="-1"/><button class="assetbtn" id="pickTo"></button></div></div>
    <div class="quote" id="squote" style="display:none"></div>
    <div id="snote"></div>
    <button class="btn grad block" id="sgo" style="margin-top:12px"></button>
    <div class="row note"><span>Slippage (per leg)</span><select id="sslip" class="inp" style="padding:4px 8px;width:auto">${[50, 100, 300, 500, 1000].map((b) => `<option value="${b}" ${b === swapState.slip ? "selected" : ""}>${b / 100}%</option>`).join("")}</select></div>
    <div class="note">ETH is wrapped to WETH automatically when needed; token → ETH swaps pay out WETH (unwrap it on the ETH ⇄ WETH page). Token → token swaps run as two trades through WETH.</div>
  </div>`;

  let list = [];
  try { list = await loadLaunches(); } catch {}
  if (id !== renderId) return;
  const tradable = list.filter((x) => (x.status === 1 || x.status === 3) && !isHidden(x.token, x.curve));
  if (preselect) {
    const x = tradable.find((y) => y.curve.toLowerCase() === preselect.toLowerCase() || y.token.toLowerCase() === preselect.toLowerCase());
    if (x) { swapState.to = assetFromLaunch(x); if (swapState.from.kind !== "eth" && swapState.from.curve === x.curve) swapState.from = ETH_ASSET; }
  }

  let seq = 0, timer, quoteRes = null;
  const parseIn = () => {
    const v = ($("#samt")?.value || "").trim();
    if (!/^\d*\.?\d+$/.test(v)) return 0n;
    try { return parseUnits(v, swapState.from.decimals); } catch { return 0n; }
  };
  const showBalances = async () => {
    if (!W.address) { $("#sbalFrom").textContent = ""; $("#sbalTo").textContent = ""; return; }
    const bal = async (a) => {
      if (!a) return "";
      if (a.kind === "eth") {
        const [e, w] = await Promise.all([pc.getBalance({ address: W.address }), balanceOf(WETH, W.address)]);
        return `${Number(formatUnits(e, 18)).toFixed(5)} ETH · ${Number(formatUnits(w, 18)).toFixed(5)} WETH`;
      }
      return `Balance: ${fmtUnits(await balanceOf(a.token, W.address), a.decimals)}`;
    };
    try { $("#sbalFrom").innerHTML = await bal(swapState.from); $("#sbalTo").innerHTML = await bal(swapState.to); } catch {}
  };
  const draw = () => {
    $("#pickFrom").innerHTML = assetLabel(swapState.from) + " ▾";
    $("#pickTo").innerHTML = assetLabel(swapState.to) + " ▾";
    const g = $("#sgo");
    g.textContent = !W.address ? "Connect wallet" : !swapState.to ? "Select a token" : "Swap";
    showBalances();
    requote();
  };

  // Quote: one leg (ETH ⇄ token) or two legs (token → WETH → token).
  const quote = async (amt) => {
    const { from, to, slip } = swapState;
    if (from.kind === "eth") {
      const ctx = await loadTradeCtx(to.curve), e = engineFor(ctx);
      if (!e) throw new Error(`${to.symbol} is not tradable right now (waiting for migration).`);
      const q = await e.quote("buy", amt, slip);
      return { amountOut: q.amountOut, minOut: q.minOut, outDec: ctx.tok.decimals, route: `ETH → ${ctx.tok.symbol} via ${e.route}`, note: q.note, legs: [{ ctx, e, side: "buy" }] };
    }
    if (to.kind === "eth") {
      const ctx = await loadTradeCtx(from.curve), e = engineFor(ctx);
      if (!e) throw new Error(`${from.symbol} is not tradable right now (waiting for migration).`);
      const q = await e.quote("sell", amt, slip);
      return { amountOut: q.amountOut, minOut: q.minOut, outDec: 18, outSym: "WETH", route: `${ctx.tok.symbol} → WETH via ${e.route}`, note: q.note, legs: [{ ctx, e, side: "sell" }] };
    }
    const [ca, cb] = await Promise.all([loadTradeCtx(from.curve), loadTradeCtx(to.curve)]);
    const ea = engineFor(ca), eb = engineFor(cb);
    if (!ea || !eb) throw new Error("One of these tokens is not tradable right now (waiting for migration).");
    const q1 = await ea.quote("sell", amt, slip);
    const q2 = await eb.quote("buy", q1.minOut, slip);         // conservative: second leg priced from leg-1 minimum
    const q2exp = await eb.quote("buy", q1.amountOut, slip).catch(() => q2);
    return {
      amountOut: q2exp.amountOut, minOut: q2.minOut, outDec: cb.tok.decimals,
      route: `${ca.tok.symbol} → WETH (${ea.route}) → ${cb.tok.symbol} (${eb.route})`,
      note: [q1.note, q2.note].filter(Boolean).join(""), legs: [{ ctx: ca, e: ea, side: "sell" }, { ctx: cb, e: eb, side: "buy" }],
    };
  };
  function requote() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const amt = parseIn(), my = ++seq;
      quoteRes = null;
      $("#snote").innerHTML = "";
      if (!amt || !swapState.to) { $("#sout").value = ""; $("#squote").style.display = "none"; return; }
      $("#sout").value = "Quoting…";
      try {
        const q = await quote(amt);
        if (my !== seq) return;
        quoteRes = q;
        $("#sout").value = formatUnits(q.amountOut, q.outDec);
        const outSym = q.outSym || (swapState.to.kind === "eth" ? "WETH" : swapState.to.symbol);
        $("#squote").style.display = "grid";
        $("#squote").innerHTML = `<div class="row"><span class="muted">Minimum received</span><b>${fmtUnits(q.minOut, q.outDec)} ${esc(outSym)}</b></div>
          <div class="row"><span class="muted">Route</span><span style="text-align:right">${esc(q.route)}</span></div>`;
        $("#snote").innerHTML = q.note || "";
      } catch (e) {
        if (my !== seq) return;
        $("#sout").value = "";
        $("#squote").style.display = "none";
        $("#snote").innerHTML = `<div class="alert err">${esc(errText(e))}</div>`;
      }
    }, 350);
  }

  // Token picker
  const pick = (which) => {
    const bg = document.createElement("div");
    bg.className = "modal-bg";
    bg.innerHTML = `<div class="modal picker"><h3>Select a token</h3>
      <input class="inp" id="pq" placeholder="Search name, symbol or paste address" autocomplete="off"/>
      <div class="plist" id="plist"></div><button class="btn ghost block" id="pclose" style="margin-top:10px">Close</button></div>`;
    document.body.appendChild(bg);
    const close = () => bg.remove();
    bg.onclick = (e) => { if (e.target === bg) close(); };
    $("#pclose", bg).onclick = close;
    const other = which === "from" ? swapState.to : swapState.from;
    const cfg = siteConfigId();
    const sorted = [...tradable].sort((a, b) => isOfficial(b) - isOfficial(a) || (b.configId === cfg) - (a.configId === cfg) || (b.mcap || 0) - (a.mcap || 0));
    const render_ = () => {
      const q = $("#pq", bg).value.trim().toLowerCase();
      const rows = [ETH_ASSET, ...sorted.map(assetFromLaunch)]
        .filter((a) => !(other && other.kind === a.kind && (a.kind === "eth" || a.curve === other.curve)))
        .filter((a) => !q || [a.symbol, a.name, a.token, a.curve].some((v) => String(v || "").toLowerCase().includes(q)))
        .slice(0, 80);
      $("#plist", bg).innerHTML = rows.length ? rows.map((a, i) => `<button class="prow" data-i="${i}">${a.kind === "eth" ? `<div class="avatar sm eth">Ξ</div>` : avatar(a, "sm")}
          <span style="flex:1;min-width:0;text-align:left"><b>${esc(a.symbol)}</b> ${a.kind === "token" ? officialBadge(a) : ""}<br><span class="muted" style="font-size:12px">${esc(a.name)}</span></span>
          ${a.kind === "token" ? statusBadge(a.status) : ""}</button>`).join("") : `<div class="muted" style="padding:14px">No tradable token found.</div>`;
      $("#plist", bg).querySelectorAll(".prow").forEach((b) => (b.onclick = () => {
        const a = rows[Number(b.dataset.i)];
        swapState[which] = a;
        close(); draw();
      }));
    };
    $("#pq", bg).oninput = render_;
    render_();
    $("#pq", bg).focus();
  };

  $("#pickFrom").onclick = () => pick("from");
  $("#pickTo").onclick = () => pick("to");
  $("#flip").onclick = () => {
    if (!swapState.to) return;
    [swapState.from, swapState.to] = [swapState.to, swapState.from];
    $("#samt").value = "";
    draw();
  };
  $("#samt").oninput = requote;
  $("#sslip").onchange = (e) => { swapState.slip = Number(e.target.value); requote(); };
  $("#sgo").onclick = async () => {
    try {
      await ensureWallet();
      if (!swapState.to) return pick("to");
      const amt = parseIn();
      if (!amt) throw new Error("Enter an amount.");
      if (swapState.from.kind === "token") {
        const bal = await balanceOf(swapState.from.token, W.address);
        if (bal < amt) throw new Error(`Insufficient ${swapState.from.symbol} balance.`);
      }
      $("#sgo").disabled = true;
      const q = await quote(amt);
      let steps;
      if (q.legs.length === 1) {
        const { e, side } = q.legs[0];
        steps = await e.buildSteps(side, amt, swapState.slip);
      } else {
        // Leg 1: token A → WETH. Leg 2 spends exactly the WETH that leg 1 delivered.
        const [l1, l2] = q.legs;
        const wBefore = await balanceOf(WETH, W.address);
        steps = await l1.e.buildSteps("sell", amt, swapState.slip);
        steps.push({ label: `Buy ${l2.ctx.tok.symbol} with the WETH received`, run: async () => {
          let got = 0n;
          for (let i = 0; i < 5 && got <= 0n; i++) { got = (await balanceOf(WETH, W.address)) - wBefore; if (got <= 0n) await sleep(2000); }
          if (got <= 0n) throw new Error("Could not confirm the WETH from the first trade. Your WETH is safe in your wallet; buy the second token from its page.");
          for (const st of await l2.e.buildSteps("buy", got, swapState.slip)) await st.run();
        } });
      }
      await stepModal("Swapping", steps).run();
      tradeCtxCache.clear();
      launchCache.at = 0;
      $("#samt").value = "";
      draw();
    } catch (e) {
      if (e.message !== "No wallet") toast(esc(errText(e)), "err", 9000);
    } finally { const g = $("#sgo"); if (g) g.disabled = false; }
  };
  draw();
}


// ── Atomic first buy helpers ──────────────────────────────────────────────────
// A fresh curve's first buy is fully determined by its Config, so the expected output can be
// computed exactly (checked against live fresh curves to the wei) for plain-fee Configs.
function atomicFirstBuyEligible(c) {
  return !!c && !c.dynamicFeeEnabled && !c.rateLimiterEnabled && !c.enableFirstSwapWithMinFee
    && Number(c.feeSchedulerMode) === 0 && Number(c.feeNumberOfPeriods) === 0 && Number(c.collectFeeMode) === 0
    && Number(c.activationDelay) === 0;
}
function freshCurveBuyQuote(config, segments, amountIn) {
  const Q2 = 1n << 128n;
  const fee = amountIn * BigInt(config.cliffFeeBps) / 10_000n;
  let rem = amountIn - fee, out = 0n, s = config.startSqrtPrice;
  for (const seg of segments) {
    if (rem <= 0n) break;
    if (s >= seg.upperSqrtPrice) continue;
    if (s < seg.lowerSqrtPrice) s = seg.lowerSqrtPrice;
    const Lq = seg.liquidity;                                     // Q64-scaled liquidity
    const maxIn = Lq * (seg.upperSqrtPrice - s) / Q2;             // quote needed to reach the segment top
    let s1;
    if (rem >= maxIn) { s1 = seg.upperSqrtPrice; rem -= maxIn; }
    else { s1 = s + rem * Q2 / Lq; rem = 0n; }
    out += Lq * (s1 - s) / (s * s1);                              // base released between s and s1
    s = s1;
  }
  return { amountOut: out, fee, unfilled: rem };
}

/* ───────────────────────────── views: earnings ───────────────────────────── */
// Creator / partner launch fees (Ammora FeeVault) and graduated LP-position fees (ARL position NFTs).
const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)");
let arlOptions = null;
const dammOptions = () => (arlOptions ??= { deploymentSource: A.createAmmoraDeploymentSource([D]), factoryProfiles: A.giwaSepoliaAutoRoutePoolProfiles });

async function viewEarnings(id) {
  if (!W.address) {
    app.innerHTML = `<div class="formcard card" style="max-width:560px"><span class="chip">💰 Earnings</span><h2 style="margin-top:12px">Your earnings</h2>
      <div class="muted">Connect your wallet to see and claim the fees you earned as a token creator, as a launchpad partner, or from graduated liquidity positions.</div>
      <button class="btn grad block" id="econnect" style="margin-top:16px">Connect wallet</button></div>`;
    $("#econnect").onclick = async () => { try { await connect(); await ensureChain(); render(); } catch (e) { if (e.message !== "No wallet") toast(esc(errText(e)), "err"); } };
    return;
  }
  const me = W.address;
  app.innerHTML = `
  <div class="formcard card" style="max-width:820px">
    <span class="chip">💰 Earnings</span>
    <h2 style="margin-top:12px">Your earnings</h2>
    <div class="muted">Fees earned by <span class="mono">${short(me)}</span> across every Ammora launch on GIWA: as a token creator, as a launchpad partner, and from liquidity positions created at graduation.</div>
    <div class="sect">Launch trading fees</div>
    <div id="evault"><div class="skel" style="height:60px"></div></div>
    <div class="sect">Graduated liquidity positions</div>
    <div id="elp"><div class="skel" style="height:60px"></div></div>
    <div class="sect">Your launches</div>
    <div id="emine"><div class="skel" style="height:40px"></div></div>
  </div>`;

  // 1) FeeVault: creator + partner shares of bonding-curve trading fees, paid in WETH.
  const loadVault = async () => {
    try {
      const vault = await pc.readContract({ address: L.factory, abi: A.ammoraLaunchFactoryV4Abi, functionName: "feeVault" });
      const owed = await pc.readContract({ address: vault, abi: A.feeVaultAbi, functionName: "claimable", args: [WETH, me] });
      if (id !== renderId) return;
      $("#evault").innerHTML = `<div class="earnrow"><div><div class="muted" style="font-size:12px">Claimable in the Ammora fee vault</div>
        <div style="font-size:24px;font-weight:800">${fmtUnits(owed, 18, 6)} WETH</div>
        <div class="muted" style="font-size:12px">Creator and partner shares from bonding-curve trades. The vault adds up all your launches.</div></div>
        <button class="btn grad" id="eclaimv" ${owed > 0n ? "" : "disabled"}>${owed > 0n ? "Claim" : "Nothing to claim"}</button></div>`;
      $("#eclaimv").onclick = async () => {
        try {
          await ensureWallet();
          $("#eclaimv").disabled = true;
          const tx = A.buildClaimFeeVaultFor(WETH, me, me);
          await stepModal("Claiming fees", [{ label: `Claim ${fmtUnits(owed, 18, 6).replace(/<[^>]+>/g, "")} WETH`, run: () => sendTx({ to: vault, data: tx.data }, "Fee claim") }]).run();
          setTimeout(loadVault, 2500);
        } catch (e) { toast(esc(errText(e)), "err", 9000); const b = $("#eclaimv"); if (b) b.disabled = false; }
      };
    } catch (e) { if (id === renderId) $("#evault").innerHTML = `<div class="alert err">Could not read the fee vault: ${esc(errText(e))}</div>`; }
  };

  // 2) LP NFTs received at graduation (or later), found through ERC-721 Transfer logs to this wallet.
  const loadLp = async () => {
    try {
      const PM = L.concentratedPositionManager;
      const logs = await explorerLogs({ address: PM, topic0: TRANSFER_TOPIC, topic2: "0x" + me.slice(2).toLowerCase().padStart(64, "0") });
      const ids = [...new Set(logs.map((l) => BigInt(l.topics[3])))].slice(-60);
      const launches = await loadLaunches().catch(() => []);
      const rows = [];
      for (const tokenId of ids) {
        const owner = await pc.readContract({ address: PM, abi: A.ammConcentratedPositionManagerV3Abi, functionName: "ownerOf", args: [tokenId] }).catch(() => null);
        if (!owner || owner.toLowerCase() !== me.toLowerCase()) continue;
        const pos = await pc.readContract({ address: PM, abi: A.ammConcentratedPositionManagerV3Abi, functionName: "getPosition", args: [tokenId] });
        let base = 0n, quote = 0n;
        try {
          const { result } = await pc.simulateContract({ address: PM, abi: A.ammConcentratedPositionManagerV3Abi, functionName: "claimPositionFees", args: [tokenId, me], account: me });
          [base, quote] = result;
        } catch {}
        const launch = launches.find((x) => x.pool && x.pool.toLowerCase() === pos.pool.toLowerCase());
        rows.push({ tokenId, pool: pos.pool, base, quote, launch, locked: pos.permanentLockedLiquidity > 0n });
      }
      if (id !== renderId) return;
      if (!rows.length) { $("#elp").innerHTML = `<div class="muted">No liquidity positions yet. When a token you created (or partnered) graduates, its LP position appears here and keeps earning pool fees.</div>`; return; }
      $("#elp").innerHTML = `<div style="overflow:auto"><table><thead><tr><th>Position</th><th>Token</th><th>Claimable</th><th></th></tr></thead><tbody>
        ${rows.map((r, i) => {
          const dec = r.launch?.decimals ?? 9, sym = r.launch?.symbol || "token";
          const has = r.base > 0n || r.quote > 0n;
          return `<tr><td>#${r.tokenId}${r.locked ? ` <span class="badge b-grad">locked</span>` : ""}</td>
            <td>${r.launch ? `<a href="#/token/${r.launch.curve}">$${esc(sym)}</a>` : `<a class="mono" href="${addrUrl(r.pool)}" target="_blank" rel="noopener">${short(r.pool)}</a>`}</td>
            <td>${fmtUnits(r.quote, 18, 6)} WETH<br><span class="muted">${fmtUnits(r.base, dec)} ${esc(sym)}</span></td>
            <td style="text-align:right"><button class="btn small ${has ? "grad" : "ghost"}" data-i="${i}" ${has ? "" : "disabled"}>${has ? "Claim" : "—"}</button></td></tr>`;
        }).join("")}</tbody></table></div>
        <div class="note">Locked positions cannot be withdrawn, but their trading fees are always claimable.</div>`;
      $("#elp").querySelectorAll("button[data-i]").forEach((b) => (b.onclick = async () => {
        const r = rows[Number(b.dataset.i)];
        try {
          await ensureWallet();
          b.disabled = true;
          const sdk = new A.DammV2Client(pc, r.pool, "concentrated", L.concentratedFactory, L.concentratedPositionManager, dammOptions());
          await stepModal("Claiming LP fees", [{ label: `Claim fees of position #${r.tokenId}`, run: async () => {
            const tx = await sdk.planClaimManagedConcentratedFees(r.tokenId, me, me);
            return sendTx({ to: tx.to, data: tx.data }, "LP fee claim");
          } }]).run();
          setTimeout(loadLp, 2500);
        } catch (e) { toast(esc(errText(e)), "err", 9000); b.disabled = false; }
      }));
    } catch (e) { if (id === renderId) $("#elp").innerHTML = `<div class="alert err">Could not load positions: ${esc(errText(e))}</div>`; }
  };

  // 3) Tokens this wallet created.
  const loadMine = async () => {
    try {
      const list = (await loadLaunches()).filter((x) => x.creator.toLowerCase() === me.toLowerCase() && !isHidden(x.token, x.curve));
      if (id !== renderId) return;
      $("#emine").innerHTML = list.length ? `<div class="grid" style="margin:0">${list.slice(0, 30).map((x) => `
        <a class="card lcard" href="#/token/${x.curve}"><div class="lhead">${avatar(x)}<div style="min-width:0;flex:1"><div class="lname">${esc(x.name || "Unnamed")}</div><div class="lsym">$${esc(x.symbol || "")}</div></div>${statusBadge(x.status)}</div>
        <div><div class="row" style="margin-bottom:6px"><span class="muted">Bonding curve</span><b>${(x.progress * 100).toFixed(1)}%</b></div><div class="bar"><i style="width:${(x.progress * 100).toFixed(1)}%"></i></div></div></a>`).join("")}</div>`
        : `<div class="muted">You have not launched a token yet. <a href="#/create">Launch one →</a></div>`;
    } catch { if (id === renderId) $("#emine").innerHTML = `<div class="muted">Could not load your launches.</div>`; }
  };

  loadVault(); loadMine(); loadLp();
}

/* ───────────────────────────── views: create ───────────────────────────── */
let coreVerified = null;
const verifyCore = async (bn) => (coreVerified ??= A.verifyAmmoraV4CoreAtBlock(pc, CORE, bn).catch((e) => { coreVerified = null; throw e; }));

async function viewCreate(id) {
  const cfgId = siteConfigId();
  app.innerHTML = `
  <div class="formcard card">
    <span class="chip">🚀 New launch</span>
    <h2 style="margin-top:12px">Launch a token</h2>
    <div class="muted">Creates a new ERC-20 and its Ammora bonding curve in one transaction, using ${esc(SITE.name)}'s launch Config #${cfgId}.</div>
    <div id="cfginfo" class="preview"><div class="skel" style="height:18px"></div><div class="skel" style="height:18px"></div></div>
    <div class="fgrid">
      <div><label class="l">Name</label><input class="inp" id="name" maxlength="40" placeholder="Moon Cat"/></div>
      <div><label class="l">Ticker</label><input class="inp" id="sym" maxlength="12" placeholder="MCAT"/></div>
      <div class="full"><label class="l">Description</label><textarea class="inp" id="desc" maxlength="280" placeholder="What is this token about? (short — it is stored on-chain)"></textarea></div>
      <div class="full"><label class="l">Image</label>
        <div class="imgpick"><div id="imgprev" class="avatar lg">?</div>
          <div style="flex:1;display:grid;gap:8px"><input type="file" id="file" accept="image/png,image/jpeg,image/webp,image/gif" class="inp"/></div></div>
        <div class="help" id="metahelp">The image is compressed to fit, together with the text, into Ammora's 2 KB on-chain metadata limit.</div></div>
      <div><label class="l">Website (optional)</label><input class="inp" id="web" placeholder="https://"/></div>
      <div><label class="l">X / Twitter (optional)</label><input class="inp" id="tw" placeholder="https://x.com/…"/></div>
      <div><label class="l">Telegram (optional)</label><input class="inp" id="tg" placeholder="https://t.me/…"/></div>
      <div><label class="l">Initial buy in ETH (optional)</label><input class="inp" id="first" inputmode="decimal" placeholder="0.001"/><div class="help">Bought in the same transaction as the launch, so nobody can buy before you. ETH is wrapped to WETH automatically.</div></div>
    </div>
    <div id="cmsg"></div>
    <button class="btn grad block" id="launch" style="margin-top:16px">${W.address ? "Launch token" : "Connect wallet & launch"}</button>
    <div class="note">You become the token's Creator and receive the Creator share of curve trading fees defined by the Config. GIWA Sepolia testnet only.</div>
  </div>`;

  let cfg = null, imgBmp = null, fitted = null;
  try {
    const bn = await pc.getBlockNumber();
    cfg = await A.getAmmoraV4ConfigAtBlock(pc, L.configRegistry, cfgId, bn);
    if (id !== renderId) return;
    const c = cfg.config;
    $("#cfginfo").innerHTML = `
      <div><span class="muted">Config</span> <b>#${cfgId}</b> ${cfg.enabled ? '<span class="good">enabled</span>' : '<span class="bad">disabled</span>'}</div>
      <div><span class="muted">Creation fee</span> <b>${formatUnits(c.poolCreationFee, 18)} ETH</b></div>
      <div><span class="muted">Total supply</span> <b>${fmtUnits(c.totalSupply, c.tokenDecimals)}</b> (${c.tokenDecimals} decimals)</div>
      <div><span class="muted">Graduates at</span> <b>${fmtUnits(c.migrationQuoteThreshold, 18)} WETH</b></div>
      <div><span class="muted">Curve fee</span> <b>${(c.cliffFeeBps / 100).toFixed(2)}%</b> · creator share ${(c.creatorShareOfNonProtocolBps / 100).toFixed(0)}%</div>
      <div><span class="muted">Partner</span> <a class="mono" href="${addrUrl(c.partnerRecipient)}" target="_blank" rel="noopener">${short(c.partnerRecipient)}</a></div>`;
    if (!cfg.enabled) $("#cmsg").innerHTML = `<div class="alert err">Config #${cfgId} is disabled. Update <span class="mono">launchConfigId</span> in src/config.js.</div>`;
  } catch (e) {
    if (id === renderId) $("#cfginfo").innerHTML = `<div class="alert err" style="grid-column:1/-1">Could not read Config #${cfgId}: ${esc(errText(e))}</div>`;
  }

  const setPrev = (src) => { $("#imgprev").outerHTML = src ? `<img id="imgprev" class="avatar lg" src="${esc(src)}" alt="">` : `<div id="imgprev" class="avatar lg">?</div>`; };
  const baseMeta = () => ({
    name: $("#name").value.trim(), symbol: $("#sym").value.trim().toUpperCase(),
    description: $("#desc").value.trim() || undefined,
    website: safeUrl($("#web").value.trim()) || undefined, twitter: safeUrl($("#tw").value.trim()) || undefined, telegram: safeUrl($("#tg").value.trim()) || undefined,
    launchpad: SITE.name,
  });
  // Recompute the exact on-chain metadata (and the image size that fits) whenever an input changes.
  let fitTimer;
  const refit = () => {
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => {
      try {
        fitted = buildMetadataUri(baseMeta(), imgBmp);
        if (imgBmp) setPrev(fitted.image);
        const used = utf8Bytes(fitted.uri);
        $("#metahelp").innerHTML = fitted.tooBig
          ? `<span class="bad">The image does not fit next to this much text. Shorten the description or links (on-chain limit ${META_LIMIT.toLocaleString("en-US")} bytes).</span>`
          : `On-chain metadata: <b>${used.toLocaleString("en-US")} / ${META_LIMIT.toLocaleString("en-US")} bytes</b>${fitted.image ? ` · image compressed to ${fitted.size}px` : ""}.`;
      } catch (e) {
        fitted = null;
        $("#metahelp").innerHTML = `<span class="bad">${esc(e.message)}</span>`;
      }
    }, 250);
  };
  ["#name", "#sym", "#desc", "#web", "#tw", "#tg"].forEach((sel) => ($(sel).oninput = refit));
  $("#file").onchange = async (e) => {
    const f = e.target.files?.[0];
    imgBmp = null;
    if (f) { try { imgBmp = await createImageBitmap(f); } catch { toast("Could not read that image.", "err"); } }
    if (!imgBmp) setPrev(null);
    refit();
  };
  refit();

  $("#launch").onclick = async () => {
    const name = $("#name").value.trim(), symbol = $("#sym").value.trim().toUpperCase();
    try {
      if (!name || !symbol) throw new Error("Name and ticker are required.");
      if (!/^[A-Z0-9$_.-]{1,12}$/.test(symbol)) throw new Error("Ticker: 1–12 letters/numbers.");
      const firstStr = $("#first").value.trim();
      const firstBuy = firstStr ? parseUnits(firstStr, 18) : 0n;
      await ensureWallet();
      if (!cfg?.enabled) throw new Error("The selected launch Config is not available.");
      const built = buildMetadataUri({ ...baseMeta(), name, symbol }, imgBmp);
      if (built.tooBig) throw new Error("The image does not fit next to this much text. Shorten the description or links, or remove the image.");
      const metadataURI = built.uri;
      const meta = built.meta;
      $("#launch").disabled = true;
      let created, atomicDone = false;
      const recordLaunch = (receipt) => {
        created = A.parseAmmoraV4LaunchCreatedReceipt(receipt, L.factory);
        if (created.configId !== cfgId || created.configHash !== cfg.configHash) throw new Error("Launch receipt does not match the selected Config.");
        rememberLaunch({ token: created.token, curve: created.curve, creator: W.address, configId: cfgId, configHash: cfg.configHash, metadataURI, block: Number(receipt.blockNumber), time: Math.floor(Date.now() / 1000), tx: receipt.transactionHash });
        metaCache.set(metadataURI, meta);
        launchCache.at = 0;
      };
      const launchArgs = () => ({ name, symbol, metadataURI, creatorMetadataURI: metadataURI, tokenDecimals: cfg.config.tokenDecimals });
      const steps = [
        { label: "Verify Ammora V4 contracts & Config", run: async () => {
          const bn = await pc.getBlockNumber();
          await verifyCore(bn);
          cfg = await A.getAmmoraV4ConfigAtBlock(pc, L.configRegistry, cfgId, bn);
          if (!cfg.enabled) throw new Error(`Config #${cfgId} is disabled.`);
          const ethBal = await pc.getBalance({ address: W.address });
          if (ethBal < cfg.config.poolCreationFee + firstBuy) throw new Error("Not enough ETH for the creation fee and initial buy (plus gas).");
        } },
      ];
      if (firstBuy > 0n && atomicFirstBuyEligible(cfg?.config)) {
        // Launch + first buy in ONE transaction through Ammora's FirstBuyExecutor: nobody can buy before the creator.
        const planAtomic = async () => {
          const bn = await pc.getBlockNumber();
          const ctx = await A.verifyAmmoraPortableDeploymentAtBlock(pc, A.giwaSepoliaAtomicLaunchDeployment, bn);
          const quoteOut = freshCurveBuyQuote(cfg.config, cfg.segments, firstBuy);
          if (quoteOut.unfilled > 0n || quoteOut.amountOut <= 0n) throw new Error("The initial buy is larger than the bonding curve allows. Use a smaller amount.");
          const fees = await pc.estimateFeesPerGas();
          return new A.AmmoraPortableLifecyclePlanner(ctx, A.giwaSepoliaAtomicLaunchTargets).planExistingConfigAtomicFirstBuy({
            account: W.address, configId: cfgId, expectedConfigHash: cfg.configHash, launch: launchArgs(),
            firstBuys: [{ includedQuoteAmountRaw: firstBuy, minimumBaseAmountOutRaw: quoteOut.amountOut * 99n / 100n, allowPartialFill: false, recipient: W.address }],
            deadline: nowSec() + 1800n, allowancePolicy: "prepare-approval",
            gas: { maxFeePerGasNativeRaw: (fees.maxFeePerGas ?? fees.gasPrice ?? 1_000_000n) * 2n, safetyMarginBps: 2000n },
          });
        };
        steps.push(
          { label: "Prepare WETH for the first buy", run: async () => {
            const wbal = await balanceOf(WETH, W.address);
            if (wbal >= firstBuy) return;
            const diff = firstBuy - wbal;
            return sendTx({ to: WETH, data: encodeFunctionData({ abi: wethAbi, functionName: "deposit" }), value: diff }, "Wrap ETH");
          } },
          { label: "Approve the first buy (exact amount)", run: async () => {
            const plan = await planAtomic();
            if (plan.status !== "APPROVAL_REQUIRED") return;
            const a = plan.approvalRequirements?.[0];
            if (!a || a.token.toLowerCase() !== WETH.toLowerCase() || a.exactAmountRaw !== firstBuy) throw new Error("Unexpected approval request from the planner.");
            return sendTx(plan.transaction, "Approval");
          } },
          { label: `Create $${symbol} + first buy in one transaction`, run: async () => {
            let plan;
            for (let i = 0; i < 4; i++) {                   // RPC replicas can lag behind the approval
              plan = await planAtomic();
              if (plan.status === "READY") break;
              await sleep(2500);
            }
            if (plan.status !== "READY") throw new Error("The approval is not visible yet. Wait a few seconds and try again.");
            if (plan.transaction.to.toLowerCase() !== L.factory.toLowerCase()) throw new Error("Unexpected launch target.");
            const receipt = await sendTx({ to: plan.transaction.to, data: plan.transaction.data, value: plan.transaction.value ?? 0n }, "Launch + first buy");
            recordLaunch(receipt);
            atomicDone = true;
          } },
        );
      } else {
        steps.push({ label: `Create $${symbol} + bonding curve`, run: async () => {
          const tx = A.buildCreateAmmoraV4Launch(launchArgs(), cfgId, cfg.config.poolCreationFee);
          recordLaunch(await sendTx({ to: L.factory, data: tx.data, value: tx.value ?? 0n }, "Token launch"));
        } });
      }
      await stepModal(`Launching ${name}`, steps).run();
      const needsBuy = firstBuy > 0n && !atomicDone;
      if (needsBuy) sessionStorage.setItem("moralume.prefillBuy", firstStr);
      toast(`🎉 $${esc(symbol)} is live!${atomicDone ? " Your first buy is in." : needsBuy ? " Confirm your initial buy on the token page." : ""}`, "ok", 9000);
      await sleep(1500);
      location.hash = `#/token/${created.curve}`;
    } catch (e) {
      $("#cmsg").innerHTML = `<div class="alert err">${esc(errText(e))}</div>`;
    } finally { const b = $("#launch"); if (b) b.disabled = false; }
  };
}

// Ammora V4 limits launch.metadataURI to 2048 UTF-8 bytes. Metadata is written as a plain JSON
// data: URI (not base64), so the embedded image's base64 is not inflated a second time.
const META_LIMIT = 2048;
const utf8Bytes = (str) => new TextEncoder().encode(str).length;
const toJsonDataUri = (obj) => "data:application/json," +
  JSON.stringify(obj).replace(/[%#\u0000-\u001f\u007f-\u{10ffff}]/gu, (ch) => encodeURIComponent(ch));
// Largest/sharpest first; the first combination that fits the limit wins.
const IMAGE_STEPS = [[96, 0.6], [80, 0.6], [72, 0.6], [64, 0.65], [64, 0.5], [56, 0.55], [48, 0.6], [48, 0.45], [40, 0.5], [32, 0.6], [32, 0.4]];
function encodeImage(bmp, size, quality) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  g.fillStyle = "#ffffff";
  g.fillRect(0, 0, size, size);
  const k = Math.max(size / bmp.width, size / bmp.height);
  const w = bmp.width * k, h = bmp.height * k;
  g.drawImage(bmp, (size - w) / 2, (size - h) / 2, w, h);
  const webp = c.toDataURL("image/webp", quality);
  return webp.startsWith("data:image/webp") ? webp : c.toDataURL("image/jpeg", quality);
}
function buildMetadataUri(base, bmp) {
  const meta = JSON.parse(JSON.stringify(base));               // drops undefined fields
  const plain = toJsonDataUri(meta);
  if (utf8Bytes(plain) > META_LIMIT) {
    throw new Error(`Too much text for the on-chain metadata limit (${utf8Bytes(plain)} / ${META_LIMIT} bytes). Shorten the description or links.`);
  }
  if (!bmp) return { uri: plain, meta, image: null };
  for (const [size, q] of IMAGE_STEPS) {
    const image = encodeImage(bmp, size, q);
    const withImage = { ...meta, image };
    const uri = toJsonDataUri(withImage);
    if (utf8Bytes(uri) <= META_LIMIT) return { uri, meta: withImage, image, size };
  }
  return { uri: plain, meta, image: null, tooBig: true };
}

/* ───────────────────────────── views: wrap ───────────────────────────── */
async function viewWallet(id) {
  app.innerHTML = `
  <div class="formcard card" style="max-width:520px">
    <span class="chip">⇄ Utility</span>
    <h2 style="margin-top:12px">ETH ⇄ WETH</h2>
    <div class="muted">Ammora curves trade against WETH (<a class="mono" href="${addrUrl(WETH)}" target="_blank" rel="noopener">${short(WETH)}</a>). Buys wrap automatically — use this to wrap or unwrap manually.</div>
    <div class="preview" id="bals"><div>ETH <b id="be">—</b></div><div>WETH <b id="bw">—</b></div></div>
    <div class="fgrid">
      <div class="full"><label class="l">Amount</label><input class="inp" id="wamt" inputmode="decimal" placeholder="0.01"/></div>
      <button class="btn grad" id="wrap">Wrap ETH → WETH</button>
      <button class="btn ghost" id="unwrap">Unwrap WETH → ETH</button>
    </div>
    <div class="note">Need testnet ETH? Free GIWA Sepolia ETH faucets:
      <a href="https://faucet.giwa.io" target="_blank" rel="noopener noreferrer">GIWA Faucet</a> ·
      <a href="https://faucet.lambda256.io/giwa-sepolia" target="_blank" rel="noopener noreferrer">Nodit</a> ·
      <a href="https://www.alchemy.com/faucets/giwa-sepolia" target="_blank" rel="noopener noreferrer">Alchemy</a></div>
  </div>`;
  const load = async () => {
    if (!W.address || id !== renderId) return;
    const [e, w] = await Promise.all([pc.getBalance({ address: W.address }), balanceOf(WETH, W.address)]);
    $("#be").textContent = Number(formatUnits(e, 18)).toFixed(6);
    $("#bw").textContent = Number(formatUnits(w, 18)).toFixed(6);
  };
  load().catch(() => {});
  const act = async (wrap) => {
    try {
      await ensureWallet();
      const amt = parseUnits($("#wamt").value.trim() || "0", 18);
      if (!amt) throw new Error("Enter an amount.");
      await stepModal(wrap ? "Wrapping" : "Unwrapping", [{ label: wrap ? "Wrap ETH" : "Unwrap WETH", run: () => sendTx(
        wrap ? { to: WETH, data: encodeFunctionData({ abi: wethAbi, functionName: "deposit" }), value: amt }
          : { to: WETH, data: encodeFunctionData({ abi: wethAbi, functionName: "withdraw", args: [amt] }) }, wrap ? "Wrap" : "Unwrap") }]).run();
      await load();
    } catch (e) { toast(esc(errText(e)), "err"); }
  };
  $("#wrap").onclick = () => act(true);
  $("#unwrap").onclick = () => act(false);
}

/* ───────────────────────────── router ───────────────────────────── */
async function render() {
  const id = ++renderId;
  renderHeader();
  const [route, arg] = location.hash.replace(/^#\/?/, "").split("/");
  window.scrollTo(0, 0);
  if (route === "token" && arg) return viewToken(id, arg);
  if (route === "create") return viewCreate(id);
  if (route === "wallet") return viewWallet(id);
  if (route === "swap") return viewSwap(id, arg);
  if (route === "earnings") return viewEarnings(id);
  return viewExplore(id);
}
window.addEventListener("hashchange", render);
if (SITE.links?.x || SITE.links?.github) {
  $("#footlinks").innerHTML += [SITE.links.x && ` · <a href="${esc(SITE.links.x)}" target="_blank" rel="noopener">X</a>`, SITE.links.github && ` · <a href="${esc(SITE.links.github)}" target="_blank" rel="noopener">GitHub</a>`].filter(Boolean).join("");
}
render();

