// ─────────────────────────────────────────────────────────────────────────────
//  Moralume site settings — edit this block.
// ─────────────────────────────────────────────────────────────────────────────
export const SITE = {
  // Brand shown in the header and page title.
  name: "Moralume",
  tagline: "Soft-glow token launches on GIWA, built on Ammora liquidity.",

  // The Ammora V4 launch Config every token created on this site uses.
  // Config #67 is Moralume's own Config: owner and partner fee recipient 0xFa25…B88C,
  // graduates at 0.05 WETH.
  launchConfigId: 67n,

  // Moderation: token or curve addresses listed here are hidden everywhere on this site
  // (explore list and token page). On-chain data is untouched; this only affects Moralume.
  // Example: hiddenTokens: ["0x1234…", "0xabcd…"],
  hiddenTokens: [],

  // Optional links shown in the footer.
  links: {
    x: "",        // e.g. "https://x.com/yourhandle"
    github: "",   // e.g. "https://github.com/you/moralume"
  },

  // Default slippage for trades, in basis points (100 = 1%).
  defaultSlippageBps: 100,
};
