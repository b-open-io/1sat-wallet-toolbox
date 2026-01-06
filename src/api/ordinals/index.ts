/**
 * Ordinals Module
 *
 * Functions for managing ordinals/inscriptions.
 * Returns WalletOutput[] directly from the SDK - no custom mapping needed.
 */

import {
  BigNumber,
  P2PKH,
  PublicKey,
  Script,
  Utils,
  type WalletInterface,
  type WalletOutput,
  type CreateActionArgs,
  type ListOutputsArgs,
} from "@bsv/sdk";
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
 * TODO: Implement cancel logic
 */
export async function cancelListing(
  _cwi: WalletInterface,
  _outpoint: string
): Promise<OrdinalOperationResponse> {
  return { error: "not-implemented" };
}

/**
 * Purchase an ordinal from the global orderbook.
 * TODO: Implement purchase logic
 */
export async function purchaseOrdinal(
  _cwi: WalletInterface,
  _request: PurchaseOrdinalRequest
): Promise<OrdinalOperationResponse> {
  return { error: "not-implemented" };
}
