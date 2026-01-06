/**
 * Broadcast Module
 *
 * Functions for broadcasting transactions.
 */

import {
  Beef,
  Transaction,
  type WalletInterface,
  type InternalizeOutput,
} from "@bsv/sdk";

export interface BroadcastRequest {
  /** Raw transaction hex */
  rawtx: string;
  /** Transaction format */
  format?: "tx" | "beef" | "ef";
  /** Description for wallet records */
  description?: string;
}

export interface BroadcastResponse {
  txid?: string;
  error?: string;
}

/**
 * Broadcast a transaction and internalize it into the wallet.
 */
export async function broadcast(
  cwi: WalletInterface,
  request: BroadcastRequest
): Promise<BroadcastResponse> {
  try {
    let tx: Transaction;
    switch (request.format) {
      case "beef":
        tx = Transaction.fromHexBEEF(request.rawtx);
        break;
      case "ef":
        tx = Transaction.fromHexEF(request.rawtx);
        break;
      default:
        tx = Transaction.fromHex(request.rawtx);
    }

    const txid = tx.id("hex");
    const beef = new Beef();
    beef.mergeTransaction(tx);

    const outputs: InternalizeOutput[] = tx.outputs.map((_, index) => ({
      outputIndex: index,
      protocol: "wallet payment" as const,
      paymentRemittance: {
        derivationPrefix: "default",
        derivationSuffix: `${txid}.${index}`,
        senderIdentityKey: "",
      },
    }));

    await cwi.internalizeAction({
      tx: Array.from(beef.toBinary()),
      outputs,
      description: request.description || "Broadcast transaction",
    });

    return { txid };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Unknown error" };
  }
}
