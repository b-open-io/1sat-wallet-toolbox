/**
 * Tokens Module
 *
 * Functions for managing BSV21 tokens.
 */

import type { WalletInterface, WalletOutput } from "@bsv/sdk";
import { BSV21_BASKET } from "../constants";

export interface Bsv21Balance {
  /** Token protocol (bsv-20) */
  p: string;
  /** Token ID (outpoint for BSV21, tick for BSV20) */
  id: string;
  /** Token symbol */
  sym?: string;
  /** Token icon URL */
  icon?: string;
  /** Decimal places */
  dec: number;
  /** Total amount (confirmed + pending) */
  amt: string;
  /** Breakdown of confirmed vs pending */
  all: {
    confirmed: bigint;
    pending: bigint;
  };
  /** Listed amounts (if applicable) */
  listed: {
    confirmed: bigint;
    pending: bigint;
  };
}

export interface SendBsv21Request {
  /** Token ID (outpoint for BSV21, tick for BSV20) */
  idOrTick: string;
  /** Destination address */
  destination: string;
  /** Amount to send (as bigint or string) */
  amount: bigint | string;
}

export interface TokenOperationResponse {
  txid?: string;
  rawtx?: string;
  error?: string;
}

/**
 * List BSV21 token outputs from the bsv21 basket.
 * Returns WalletOutput[] directly - use tags for metadata.
 */
export async function listTokens(
  cwi: WalletInterface,
  limit = 10000
): Promise<WalletOutput[]> {
  const result = await cwi.listOutputs({
    basket: BSV21_BASKET,
    includeTags: true,
    limit,
  });
  return result.outputs;
}

/**
 * Get aggregated BSV21 token balances.
 * Groups outputs by token ID and sums amounts.
 */
export async function getBsv21Balances(cwi: WalletInterface): Promise<Bsv21Balance[]> {
  const outputs = await listTokens(cwi);

  const balanceMap = new Map<string, {
    id: string;
    confirmed: bigint;
    pending: bigint;
    icon?: string;
    sym?: string;
    dec: number;
  }>();

  for (const o of outputs) {
    const idTag = o.tags?.find((t) => t.startsWith("id:"));
    const amtTag = o.tags?.find((t) => t.startsWith("amt:"))?.slice(4);
    if (!idTag || !amtTag) continue;

    const idContent = idTag.slice(3);
    const lastColonIdx = idContent.lastIndexOf(":");
    if (lastColonIdx === -1) continue;

    const tokenId = idContent.slice(0, lastColonIdx);
    const status = idContent.slice(lastColonIdx + 1);
    if (status === "invalid") continue;

    const isConfirmed = status === "valid";
    const amt = BigInt(amtTag);
    const dec = parseInt(o.tags?.find((t) => t.startsWith("dec:"))?.slice(4) || "0", 10);
    const symTag = o.tags?.find((t) => t.startsWith("sym:"))?.slice(4);
    const iconTag = o.tags?.find((t) => t.startsWith("icon:"))?.slice(5);

    const existing = balanceMap.get(tokenId);
    if (existing) {
      if (isConfirmed) existing.confirmed += amt;
      else existing.pending += amt;
    } else {
      balanceMap.set(tokenId, {
        id: tokenId,
        confirmed: isConfirmed ? amt : 0n,
        pending: isConfirmed ? 0n : amt,
        sym: symTag,
        icon: iconTag,
        dec,
      });
    }
  }

  return Array.from(balanceMap.values()).map((b) => ({
    p: "bsv-20",
    op: "transfer",
    dec: b.dec,
    amt: (b.confirmed + b.pending).toString(),
    id: b.id,
    sym: b.sym,
    icon: b.icon,
    all: { confirmed: b.confirmed, pending: b.pending },
    listed: { confirmed: 0n, pending: 0n },
  }));
}

/**
 * Send BSV21 tokens to an address.
 * TODO: Implement send logic
 */
export async function sendBsv21(
  _cwi: WalletInterface,
  _request: SendBsv21Request
): Promise<TokenOperationResponse> {
  return { error: "not-implemented" };
}

/**
 * Purchase BSV21 tokens from marketplace.
 * TODO: Implement purchase logic
 */
export async function purchaseBsv21(
  _cwi: WalletInterface,
  _outpoint: string
): Promise<TokenOperationResponse> {
  return { error: "not-implemented" };
}
