/**
 * Balance Module
 *
 * Functions for querying wallet balance and payment UTXOs.
 */

import type { WalletInterface } from "@bsv/sdk";
import { FUNDING_BASKET, WOC_MAINNET_URL, WOC_TESTNET_URL, EXCHANGE_RATE_CACHE_TTL } from "../constants";

export interface Balance {
  /** Balance in satoshis */
  satoshis: number;
  /** Balance in BSV */
  bsv: number;
  /** Balance in USD cents */
  usdInCents: number;
}

export interface PaymentUtxo {
  txid: string;
  vout: number;
  satoshis: number;
  script: string;
}

// Module-level cache for exchange rate
let exchangeRateCache: { rate: number; timestamp: number } | null = null;

/**
 * Get wallet balance with USD conversion.
 */
export async function getBalance(
  cwi: WalletInterface,
  chain: "main" | "test" = "main",
  wocApiKey?: string
): Promise<Balance> {
  const exchangeRate = await getExchangeRate(chain, wocApiKey);
  const result = await cwi.listOutputs({ basket: FUNDING_BASKET, limit: 10000 });
  console.log(
    `[getBalance] Found ${result.outputs.length} outputs in "${FUNDING_BASKET}" basket, total: ${result.totalOutputs}`,
  );
  const satoshis = result.outputs.reduce((sum, o) => sum + o.satoshis, 0);
  console.log(`[getBalance] Total satoshis: ${satoshis}`);
  const bsv = satoshis / 100_000_000;
  const usdInCents = Math.round(bsv * exchangeRate * 100);
  return { satoshis, bsv, usdInCents };
}

/**
 * Get payment UTXOs for external use.
 */
export async function getPaymentUtxos(cwi: WalletInterface): Promise<PaymentUtxo[]> {
  const result = await cwi.listOutputs({
    basket: FUNDING_BASKET,
    include: "locking scripts",
    limit: 10000,
  });
  return result.outputs.map((o) => {
    const [txid, voutStr] = o.outpoint.split(".");
    return {
      txid,
      vout: parseInt(voutStr, 10),
      satoshis: o.satoshis,
      script: o.lockingScript || "",
    };
  });
}

/**
 * Get current BSV/USD exchange rate.
 */
export async function getExchangeRate(
  chain: "main" | "test" = "main",
  wocApiKey?: string
): Promise<number> {
  if (exchangeRateCache && Date.now() - exchangeRateCache.timestamp < EXCHANGE_RATE_CACHE_TTL) {
    return exchangeRateCache.rate;
  }

  const baseUrl = chain === "main" ? WOC_MAINNET_URL : WOC_TESTNET_URL;
  const headers: Record<string, string> = {};
  if (wocApiKey) headers["woc-api-key"] = wocApiKey;

  try {
    const response = await fetch(`${baseUrl}/exchangerate`, { headers });
    if (!response.ok) throw new Error(`Failed to fetch: ${response.statusText}`);

    const data = await response.json();
    const rate = Number(data.rate.toFixed(2));
    exchangeRateCache = { rate, timestamp: Date.now() };
    return rate;
  } catch {
    return exchangeRateCache?.rate ?? 0;
  }
}

/**
 * Get chain info from WhatsOnChain.
 */
export async function getChainInfo(
  chain: "main" | "test" = "main",
  wocApiKey?: string
): Promise<{ blocks: number } | null> {
  const baseUrl = chain === "main" ? WOC_MAINNET_URL : WOC_TESTNET_URL;
  const headers: Record<string, string> = {};
  if (wocApiKey) headers["woc-api-key"] = wocApiKey;

  try {
    const response = await fetch(`${baseUrl}/chain/info`, { headers });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}
