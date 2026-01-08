/**
 * Tokens Module
 *
 * Functions for managing BSV21 tokens.
 */

import {
  BigNumber,
  LockingScript,
  OP,
  P2PKH,
  PublicKey,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Utils,
  type WalletInterface,
  type WalletOutput,
} from "@bsv/sdk";
import { BSV21, OrdLock } from "@bopen-io/templates";
import type { OneSatServices } from "../../services/OneSatServices";
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
  /** Token ID (txid_vout format) */
  tokenId: string;
  /** Destination address */
  address: string;
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
 *
 * Flow:
 * 1. Get token UTXOs from basket
 * 2. Validate each with BSV21 service
 * 3. Select UTXOs until we have enough tokens
 * 4. Build transfer inscription outputs
 * 5. Create and sign transaction
 */
export async function sendBsv21(
  cwi: WalletInterface,
  request: SendBsv21Request,
  services?: OneSatServices
): Promise<TokenOperationResponse> {
  try {
    const { tokenId, address, amount: rawAmount } = request;
    const amount = typeof rawAmount === "string" ? BigInt(rawAmount) : rawAmount;

    // Validate amount
    if (amount <= 0n) {
      return { error: "amount-must-be-positive" };
    }

    // Validate token ID format (txid_vout)
    const parts = tokenId.split("_");
    if (parts.length !== 2 || parts[0].length !== 64 || !/^\d+$/.test(parts[1])) {
      return { error: "invalid-token-id-format" };
    }

    // Get token UTXOs from basket
    const result = await cwi.listOutputs({
      basket: BSV21_BASKET,
      includeTags: true,
      include: "locking scripts",
      limit: 10000,
    });

    // Filter UTXOs matching tokenId (exclude invalid)
    const tokenUtxos = result.outputs.filter((o) => {
      const idTag = o.tags?.find((t) => t.startsWith("id:"));
      if (!idTag) return false;

      const idContent = idTag.slice(3); // Remove "id:" prefix
      const lastColonIdx = idContent.lastIndexOf(":");
      if (lastColonIdx === -1) return false;

      const id = idContent.slice(0, lastColonIdx);
      const status = idContent.slice(lastColonIdx + 1);

      return id === tokenId && status !== "invalid";
    });

    if (tokenUtxos.length === 0) {
      return { error: "no-token-utxos-found" };
    }

    // Validate UTXOs with BSV21 service and select valid ones
    const selected: WalletOutput[] = [];
    let totalIn = 0n;

    for (const utxo of tokenUtxos) {
      if (totalIn >= amount) break;

      // Get amount from tag
      const amtTag = utxo.tags?.find((t) => t.startsWith("amt:"));
      if (!amtTag) continue;
      const utxoAmount = BigInt(amtTag.slice(4));

      // Validate with BSV21 service if available
      if (services?.bsv21) {
        try {
          const [txid] = utxo.outpoint.split("_");
          const validation = await services.bsv21.getTokenByTxid(tokenId, txid);
          // If the output is returned and exists in outputs, it's valid
          const outputData = validation.outputs.find(
            (o) => `${validation.txid}_${o.vout}` === utxo.outpoint
          );
          if (!outputData) {
            continue; // Skip if not found in response
          }
        } catch {
          // If 404 or any error, the overlay doesn't know about it - skip
          continue;
        }
      }

      selected.push(utxo);
      totalIn += utxoAmount;
    }

    if (totalIn < amount) {
      return { error: "insufficient-validated-tokens" };
    }

    // Build outputs
    const outputs: Array<{
      lockingScript: string;
      satoshis: number;
      outputDescription: string;
      basket?: string;
      tags?: string[];
    }> = [];

    // Output 1: Token transfer to destination
    const p2pkh = new P2PKH();
    const destinationLockingScript = p2pkh.lock(address);
    const transferScript = BSV21.transfer(tokenId, amount).lock(destinationLockingScript);
    outputs.push({
      lockingScript: transferScript.toHex(),
      satoshis: 1,
      outputDescription: `Send ${amount} tokens`,
    });

    // Output 2: Token change (if any)
    const change = totalIn - amount;
    if (change > 0n) {
      // Derive change address
      const keyID = `${tokenId}-change-${Date.now()}`;
      const { publicKey } = await cwi.getPublicKey({
        protocolID: [1, "bsv21"],
        keyID,
        counterparty: "self",
        forSelf: true,
      });
      const changeAddress = PublicKey.fromString(publicKey).toAddress();
      const changeLockingScript = p2pkh.lock(changeAddress);
      const changeScript = BSV21.transfer(tokenId, change).lock(changeLockingScript);

      outputs.push({
        lockingScript: changeScript.toHex(),
        satoshis: 1,
        outputDescription: "Token change",
        basket: BSV21_BASKET,
        tags: [`id:${tokenId}:pending`, `amt:${change}`],
      });
    }

    // Get token symbol for description
    const symTag = tokenUtxos[0]?.tags?.find((t) => t.startsWith("sym:"));
    const symbol = symTag ? symTag.slice(4) : tokenId.slice(0, 8);

    // Create the transaction
    const createResult = await cwi.createAction({
      description: `Send ${amount} ${symbol}`,
      inputs: selected.map((o) => ({
        outpoint: o.outpoint,
        inputDescription: "Token input",
      })),
      outputs,
      options: { signAndProcess: false },
    });

    if ("error" in createResult && createResult.error) {
      return { error: String(createResult.error) };
    }

    if (!createResult.signableTransaction) {
      return { error: "no-signable-transaction" };
    }

    // Sign and broadcast - all inputs are P2PKH, wallet handles signing
    const signResult = await cwi.signAction({
      reference: createResult.signableTransaction.reference,
      spends: {},
    });

    if ("error" in signResult) {
      return { error: String(signResult.error) };
    }

    return {
      txid: signResult.txid,
      rawtx: signResult.tx ? Buffer.from(signResult.tx).toString("hex") : undefined,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "unknown-error" };
  }
}

export interface PurchaseBsv21Request {
  /** Token ID (txid_vout format of the deploy transaction) */
  tokenId: string;
  /** Outpoint of listed token UTXO (OrdLock containing BSV21) */
  outpoint: string;
  /** Amount of tokens in the listing */
  amount: bigint | string;
  /** Optional marketplace fee address */
  marketplaceAddress?: string;
  /** Optional marketplace fee rate (0-1) */
  marketplaceRate?: number;
}

/**
 * Build serialized transaction output (satoshis + script) for OrdLock unlock.
 */
function buildSerializedOutput(satoshis: number, script: number[]): number[] {
  const writer = new Utils.Writer();
  writer.writeUInt64LEBn(new BigNumber(satoshis));
  writer.writeVarIntNum(script.length);
  writer.write(script);
  return writer.toArray();
}

/**
 * Build OrdLock purchase unlocking script.
 * The purchase path requires no signature - just preimage and output data.
 */
async function buildPurchaseUnlockingScript(
  tx: Transaction,
  inputIndex: number,
  sourceSatoshis: number,
  lockingScript: LockingScript
): Promise<UnlockingScript> {
  if (tx.outputs.length < 2) {
    throw new Error("Malformed transaction: requires at least 2 outputs");
  }

  const script = new UnlockingScript()
    .writeBin(buildSerializedOutput(
      tx.outputs[0].satoshis ?? 0,
      tx.outputs[0].lockingScript.toBinary()
    ));

  if (tx.outputs.length > 2) {
    const writer = new Utils.Writer();
    for (const output of tx.outputs.slice(2)) {
      writer.write(buildSerializedOutput(output.satoshis ?? 0, output.lockingScript.toBinary()));
    }
    script.writeBin(writer.toArray());
  } else {
    script.writeOpCode(OP.OP_0);
  }

  const input = tx.inputs[inputIndex];
  const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id("hex");
  if (!sourceTXID) {
    throw new Error("sourceTXID is required");
  }

  const preimage = TransactionSignature.format({
    sourceTXID,
    sourceOutputIndex: input.sourceOutputIndex,
    sourceSatoshis,
    transactionVersion: tx.version,
    otherInputs: [],
    inputIndex,
    outputs: tx.outputs,
    inputSequence: input.sequence ?? 0xffffffff,
    subscript: lockingScript,
    lockTime: tx.lockTime,
    scope: TransactionSignature.SIGHASH_ALL |
      TransactionSignature.SIGHASH_ANYONECANPAY |
      TransactionSignature.SIGHASH_FORKID
  });

  return script.writeBin(preimage).writeOpCode(OP.OP_0);
}

/**
 * Purchase BSV21 tokens from marketplace.
 *
 * Flow:
 * 1. Fetch listing BEEF to get the locking script
 * 2. Decode OrdLock to get price and payout
 * 3. Build BSV21 transfer output for buyer
 * 4. Build payment output for seller
 * 5. Build custom OrdLock purchase unlock (preimage only, no signature)
 */
export async function purchaseBsv21(
  cwi: WalletInterface,
  request: PurchaseBsv21Request,
  services?: OneSatServices
): Promise<TokenOperationResponse> {
  try {
    const { tokenId, outpoint, amount: rawAmount, marketplaceAddress, marketplaceRate } = request;
    const tokenAmount = typeof rawAmount === "string" ? BigInt(rawAmount) : rawAmount;

    if (!services) {
      return { error: "services-required-for-purchase" };
    }

    // Parse outpoint
    const parts = outpoint.split("_");
    if (parts.length !== 2) {
      return { error: "invalid-outpoint-format" };
    }
    const [txid, voutStr] = parts;
    const vout = parseInt(voutStr, 10);

    // Fetch listing BEEF to get the locking script
    const beef = await services.getBeefForTxid(txid);
    const listingBeefTx = beef.findTxid(txid);
    if (!listingBeefTx?.tx) {
      return { error: "listing-transaction-not-found" };
    }

    const listingOutput = listingBeefTx.tx.outputs[vout];
    if (!listingOutput) {
      return { error: "listing-output-not-found" };
    }

    // Decode OrdLock from listing script
    const ordLockData = OrdLock.decode(listingOutput.lockingScript);
    if (!ordLockData) {
      return { error: "not-an-ordlock-listing" };
    }

    // Derive our token receive address
    const { publicKey } = await cwi.getPublicKey({
      protocolID: [1, "bsv21"],
      keyID: `${tokenId}-${outpoint}`,
      counterparty: "self",
      forSelf: true,
    });
    const ourTokenAddress = PublicKey.fromString(publicKey).toAddress();

    // Build outputs
    const outputs: Array<{
      lockingScript: string;
      satoshis: number;
      outputDescription: string;
      basket?: string;
      tags?: string[];
    }> = [];

    // Output 0: Token transfer to buyer (BSV21 inscription + P2PKH)
    const p2pkh = new P2PKH();
    const buyerLockingScript = p2pkh.lock(ourTokenAddress);
    const transferScript = BSV21.transfer(tokenId, tokenAmount).lock(buyerLockingScript);
    outputs.push({
      lockingScript: transferScript.toHex(),
      satoshis: 1,
      outputDescription: "Purchased tokens",
      basket: BSV21_BASKET,
      tags: [`id:${tokenId}:pending`, `amt:${tokenAmount}`],
    });

    // Output 1: Payment to seller (from payout in OrdLock)
    // Parse payout: 8-byte LE satoshis + varint script length + script
    const payoutReader = new Utils.Reader(ordLockData.payout);
    const payoutSatoshis = payoutReader.readUInt64LEBn().toNumber();
    const payoutScriptLen = payoutReader.readVarIntNum();
    const payoutScriptBin = payoutReader.read(payoutScriptLen);
    const payoutLockingScript = LockingScript.fromBinary(payoutScriptBin);

    outputs.push({
      lockingScript: payoutLockingScript.toHex(),
      satoshis: payoutSatoshis,
      outputDescription: "Payment to seller",
    });

    // Output 2+ (optional): Marketplace fee
    if (marketplaceAddress && marketplaceRate && marketplaceRate > 0) {
      const marketFee = Math.ceil(payoutSatoshis * marketplaceRate);
      if (marketFee > 0) {
        outputs.push({
          lockingScript: p2pkh.lock(marketplaceAddress).toHex(),
          satoshis: marketFee,
          outputDescription: "Marketplace fee",
        });
      }
    }

    // Create the transaction with signAndProcess: false
    // The listing input needs custom unlocking script
    const createResult = await cwi.createAction({
      description: `Purchase ${tokenAmount} tokens for ${payoutSatoshis} sats`,
      inputBEEF: beef.toBinary(),
      inputs: [{
        outpoint,
        inputDescription: "Listed token",
        unlockingScriptLength: 500, // Estimate for purchase unlock (preimage + outputs)
      }],
      outputs,
      options: { signAndProcess: false },
    });

    if ("error" in createResult && createResult.error) {
      return { error: String(createResult.error) };
    }

    if (!createResult.signableTransaction) {
      return { error: "no-signable-transaction" };
    }

    // Parse the transaction to build purchase unlock
    const tx = Transaction.fromBEEF(createResult.signableTransaction.tx);

    // Build purchase unlocking script
    const unlockingScript = await buildPurchaseUnlockingScript(
      tx,
      0,
      listingOutput.satoshis ?? 1,
      listingOutput.lockingScript
    );

    // Sign and broadcast
    const signResult = await cwi.signAction({
      reference: createResult.signableTransaction.reference,
      spends: {
        0: { unlockingScript: unlockingScript.toHex() },
      },
    });

    if ("error" in signResult) {
      return { error: String(signResult.error) };
    }

    return {
      txid: signResult.txid,
      rawtx: signResult.tx ? Buffer.from(signResult.tx).toString("hex") : undefined,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "unknown-error" };
  }
}
