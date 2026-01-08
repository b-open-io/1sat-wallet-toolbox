/**
 * Ordinals Module
 *
 * Functions for managing ordinals/inscriptions.
 * Returns WalletOutput[] directly from the SDK - no custom mapping needed.
 */

import {
  BigNumber,
  Hash,
  LockingScript,
  OP,
  P2PKH,
  PublicKey,
  Script,
  Transaction,
  TransactionSignature,
  UnlockingScript,
  Utils,
  type WalletInterface,
  type WalletOutput,
  type CreateActionArgs,
  type ListOutputsArgs,
} from "@bsv/sdk";
import { OrdLock } from "@bopen-io/templates";
import type { OneSatServices } from "../../services/OneSatServices";
import { ORDINALS_BASKET, ORDLOCK_PREFIX, ORDLOCK_SUFFIX } from "../constants";

// Protocol for ordinal listing key derivation (security level 1 = low, self-only)
const ORDINAL_LISTING_PROTOCOL: [0 | 1 | 2, string] = [1, "ordinal listing"];

export interface TransferOrdinalRequest {
  /** Outpoint of the ordinal to transfer (txid_vout or txid.vout format) */
  outpoint: string;
  /** Destination address or paymail */
  destination: string;
}

export interface ListOrdinalRequest {
  /** Outpoint of ordinal to list */
  outpoint: string;
  /** Price in satoshis */
  price: number;
  /** Address that receives payment on purchase (BRC-29 receive address) */
  payAddress: string;
  /** Address that can cancel the listing (optional - derived from CWI if not provided) */
  cancelAddress?: string;
}

export interface PurchaseOrdinalRequest {
  /** Outpoint of listing to purchase */
  outpoint: string;
  /** Marketplace address for fees */
  marketplaceAddress?: string;
  /** Marketplace fee rate (0-1) */
  marketplaceRate?: number;
}

export interface OrdinalOperationResponse {
  txid?: string;
  rawtx?: string;
  error?: string;
}

/**
 * Check if address is a paymail.
 */
function isPaymail(address: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(address);
}

/**
 * Derive a cancel address for an ordinal listing.
 * Uses the outpoint as keyID with security level 1 (self-only).
 */
export async function deriveCancelAddress(
  cwi: WalletInterface,
  outpoint: string
): Promise<string> {
  const result = await cwi.getPublicKey({
    protocolID: ORDINAL_LISTING_PROTOCOL,
    keyID: outpoint,
    forSelf: true,
  });
  const publicKey = PublicKey.fromString(result.publicKey);
  return publicKey.toAddress();
}

/**
 * Build OrdLock script for listing an ordinal.
 */
function buildOrdLockScript(ordAddress: string, payAddress: string, price: number): Script {
  const cancelPkh = Utils.fromBase58Check(ordAddress).data as number[];
  const payPkh = Utils.fromBase58Check(payAddress).data as number[];
  const payoutScript = new P2PKH().lock(payPkh).toBinary();

  const writer = new Utils.Writer();
  writer.writeUInt64LEBn(new BigNumber(price));
  writer.writeVarIntNum(payoutScript.length);
  writer.write(payoutScript);
  const payoutOutput = writer.toArray();

  return new Script()
    .writeScript(Script.fromHex(ORDLOCK_PREFIX))
    .writeBin(cancelPkh)
    .writeBin(payoutOutput)
    .writeScript(Script.fromHex(ORDLOCK_SUFFIX));
}

/**
 * List ordinals from the 1sat basket.
 * Returns WalletOutput[] directly - use tags for metadata (origin:, type:, name:, own:, list:).
 */
export async function listOrdinals(
  cwi: WalletInterface,
  options: Partial<ListOutputsArgs> = {}
): Promise<WalletOutput[]> {
  const result = await cwi.listOutputs({
    basket: ORDINALS_BASKET,
    includeTags: true,
    includeCustomInstructions: true,
    limit: options.limit ?? 100,
    offset: options.offset ?? 0,
    ...options,
  });
  return result.outputs;
}

/**
 * Build CreateActionArgs for transferring an ordinal.
 * Does NOT execute - returns params for createAction.
 */
export async function buildTransferOrdinal(
  cwi: WalletInterface,
  request: TransferOrdinalRequest
): Promise<CreateActionArgs | { error: string }> {
  const { outpoint, destination } = request;

  if (isPaymail(destination)) {
    return { error: "paymail-not-yet-implemented" };
  }

  const result = await cwi.listOutputs({
    basket: ORDINALS_BASKET,
    include: "locking scripts",
    limit: 10000,
  });

  if (!result.outputs.find((o) => o.outpoint === outpoint)) {
    return { error: "ordinal-not-found" };
  }

  return {
    description: "Transfer ordinal",
    inputs: [{ outpoint, inputDescription: "Ordinal to transfer" }],
    outputs: [{
      lockingScript: new P2PKH().lock(destination).toHex(),
      satoshis: 1,
      outputDescription: "Ordinal transfer",
    }],
  };
}

/**
 * Build CreateActionArgs for listing an ordinal for sale.
 * Does NOT execute - returns params for createAction.
 * If cancelAddress is not provided, it will be derived from the CWI.
 */
export async function buildListOrdinal(
  cwi: WalletInterface,
  request: ListOrdinalRequest
): Promise<CreateActionArgs | { error: string }> {
  const { outpoint, price, payAddress } = request;

  if (!payAddress) return { error: "missing-pay-address" };
  if (price <= 0) return { error: "invalid-price" };

  const result = await cwi.listOutputs({
    basket: ORDINALS_BASKET,
    include: "locking scripts",
    limit: 10000,
  });

  if (!result.outputs.find((o) => o.outpoint === outpoint)) {
    return { error: "ordinal-not-found" };
  }

  // Derive cancel address if not provided
  const cancelAddress = request.cancelAddress ?? await deriveCancelAddress(cwi, outpoint);

  const lockingScript = buildOrdLockScript(cancelAddress, payAddress, price);

  return {
    description: `List ordinal for ${price} sats`,
    inputs: [{ outpoint, inputDescription: "Ordinal to list" }],
    outputs: [{
      lockingScript: lockingScript.toHex(),
      satoshis: 1,
      outputDescription: `List ordinal for ${price} sats`,
      basket: ORDINALS_BASKET,
      tags: [`origin:${outpoint}`, `price:${price}`],
    }],
  };
}

/**
 * Transfer an ordinal to a new address.
 */
export async function transferOrdinal(
  cwi: WalletInterface,
  request: TransferOrdinalRequest
): Promise<OrdinalOperationResponse> {
  try {
    const params = await buildTransferOrdinal(cwi, request);
    if ("error" in params) {
      return params;
    }

    const result = await cwi.createAction(params);

    if (!result.txid) {
      return { error: "no-txid-returned" };
    }
    return { txid: result.txid, rawtx: result.tx ? Utils.toHex(result.tx) : undefined };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "unknown-error" };
  }
}

/**
 * List an ordinal for sale on the global orderbook.
 */
export async function listOrdinal(
  cwi: WalletInterface,
  request: ListOrdinalRequest
): Promise<OrdinalOperationResponse> {
  try {
    const params = await buildListOrdinal(cwi, request);
    if ("error" in params) {
      return params;
    }

    const result = await cwi.createAction(params);

    if (!result.txid) {
      return { error: "no-txid-returned" };
    }
    return { txid: result.txid, rawtx: result.tx ? Utils.toHex(result.tx) : undefined };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "unknown-error" };
  }
}

/**
 * Cancel an ordinal listing.
 * Uses the origin tag to recover the keyID for signing.
 * Cancel unlock script: <sig> <pubkey> OP_1
 */
export async function cancelListing(
  cwi: WalletInterface,
  outpoint: string
): Promise<OrdinalOperationResponse> {
  try {
    // Find the listing in our wallet
    const result = await cwi.listOutputs({
      basket: ORDINALS_BASKET,
      includeTags: true,
      include: "locking scripts",
      limit: 10000,
    });

    const listing = result.outputs.find((o) => o.outpoint === outpoint);
    if (!listing) {
      return { error: "listing-not-found" };
    }

    // Get the origin tag to recover the keyID
    const originTag = listing.tags?.find((t) => t.startsWith("origin:"));
    if (!originTag) {
      return { error: "missing-origin-tag" };
    }
    const originOutpoint = originTag.slice(7); // Remove "origin:" prefix

    // Derive the cancel address to get output destination
    const cancelAddress = await deriveCancelAddress(cwi, originOutpoint);

    // Create transaction with signAndProcess: false
    const createResult = await cwi.createAction({
      description: "Cancel ordinal listing",
      inputs: [{
        outpoint,
        inputDescription: "Listed ordinal",
        unlockingScriptLength: 108, // sig (73) + pubkey (34) + OP_1 (1)
      }],
      outputs: [{
        lockingScript: new P2PKH().lock(cancelAddress).toHex(),
        satoshis: 1,
        outputDescription: "Cancelled listing",
        basket: ORDINALS_BASKET,
      }],
      options: { signAndProcess: false },
    });

    if ("error" in createResult && createResult.error) {
      return { error: String(createResult.error) };
    }

    if (!createResult.signableTransaction) {
      return { error: "no-signable-transaction" };
    }

    // Parse transaction for signing
    const tx = Transaction.fromBEEF(createResult.signableTransaction.tx);
    const input = tx.inputs[0];
    const lockingScript = Script.fromHex(listing.lockingScript!);

    // Build preimage for signature
    const sourceTXID = input.sourceTXID ?? input.sourceTransaction?.id("hex");
    if (!sourceTXID) {
      return { error: "missing-source-txid" };
    }

    const preimage = TransactionSignature.format({
      sourceTXID,
      sourceOutputIndex: input.sourceOutputIndex,
      sourceSatoshis: listing.satoshis,
      transactionVersion: tx.version,
      otherInputs: [],
      inputIndex: 0,
      outputs: tx.outputs,
      inputSequence: input.sequence ?? 0xffffffff,
      subscript: lockingScript,
      lockTime: tx.lockTime,
      scope: TransactionSignature.SIGHASH_ALL |
        TransactionSignature.SIGHASH_ANYONECANPAY |
        TransactionSignature.SIGHASH_FORKID,
    });

    // Hash preimage for signing
    const sighash = Hash.sha256(Hash.sha256(preimage));

    // Get signature via createSignature using origin outpoint as keyID
    const { signature } = await cwi.createSignature({
      protocolID: ORDINAL_LISTING_PROTOCOL,
      keyID: originOutpoint,
      counterparty: "self",
      hashToDirectlySign: Array.from(sighash),
    });

    // Get public key
    const { publicKey } = await cwi.getPublicKey({
      protocolID: ORDINAL_LISTING_PROTOCOL,
      keyID: originOutpoint,
      forSelf: true,
    });

    // Build cancel unlocking script: <sig> <pubkey> OP_1
    const unlockingScript = new UnlockingScript()
      .writeBin(signature)
      .writeBin(Utils.toArray(publicKey, "hex"))
      .writeOpCode(OP.OP_1);

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
      rawtx: signResult.tx ? Utils.toHex(signResult.tx) : undefined,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "unknown-error" };
  }
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
 * Purchase an ordinal from the global orderbook.
 *
 * Flow:
 * 1. Fetch listing BEEF to get the locking script
 * 2. Decode OrdLock to get price and payout
 * 3. Build P2PKH output for buyer
 * 4. Build payment output for seller
 * 5. Build custom OrdLock purchase unlock (preimage only, no signature)
 */
export async function purchaseOrdinal(
  cwi: WalletInterface,
  request: PurchaseOrdinalRequest,
  services?: OneSatServices
): Promise<OrdinalOperationResponse> {
  try {
    const { outpoint, marketplaceAddress, marketplaceRate } = request;

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

    // Derive our ordinal receive address
    const { publicKey } = await cwi.getPublicKey({
      protocolID: [1, "ordinals"],
      keyID: outpoint,
      counterparty: "self",
      forSelf: true,
    });
    const ourOrdAddress = PublicKey.fromString(publicKey).toAddress();

    // Build outputs
    const outputs: Array<{
      lockingScript: string;
      satoshis: number;
      outputDescription: string;
      basket?: string;
      tags?: string[];
    }> = [];

    // Output 0: Ordinal to buyer (P2PKH)
    const p2pkh = new P2PKH();
    outputs.push({
      lockingScript: p2pkh.lock(ourOrdAddress).toHex(),
      satoshis: 1,
      outputDescription: "Purchased ordinal",
      basket: ORDINALS_BASKET,
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
      description: `Purchase ordinal for ${payoutSatoshis} sats`,
      inputBEEF: beef.toBinary(),
      inputs: [{
        outpoint,
        inputDescription: "Listed ordinal",
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
      rawtx: signResult.tx ? Utils.toHex(signResult.tx) : undefined,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "unknown-error" };
  }
}
