import { parseUnits } from "viem";

/** USD per 1 whole token (18 decimals) — manual stablecoin peg. */
export const MANUAL_USD_PEG_18 = parseUnits("1", 18);

/** Circle USDC by chain (no Chainlink collateral feed; use manual $1 peg). */
export const USDC_UNDERLYING: Partial<Record<number, `0x${string}`>> = {
  11155111: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  31337: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238",
  43113: "0x5425890298aed601595a70AB815c96711a31Bc65",
  1: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  43114: "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9fcd248",
};

export const usdcUnderlyingForChain = (chainId: number): `0x${string}` | undefined =>
  USDC_UNDERLYING[chainId];
