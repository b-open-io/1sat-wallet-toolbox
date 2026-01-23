/**
 * Ordinals Module
 *
 * Skills for managing ordinals/inscriptions.
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
  type WalletOutput,
  type CreateActionArgs,
} from "@bsv/sdk";
import { OrdLock } from "@bopen-io/templates";
import type { Skill, OneSatContext } from "../skills/types";
import { ORDINALS_BASKET, ORDLOCK_PREFIX, ORDLOCK_SUFFIX, ONESAT_PROTOCOL } from "../constants";

// ============================================================================
// Types
// ============================================================================

type PubKeyHex = string;

export interface TransferOrdinalRequest {
  /** Outpoint of the ordinal to transfer (txid_vout format) */
  outpoint: string;
  /** Recipient's identity public key (preferred) */
  counterparty?: PubKeyHex;
  /** Legacy: raw P2PKH address */
  address?: string;
  /** Paymail address */
  paymail?: string;
}

export interface ListOrdinalRequest {
  /** Outpoint of ordinal to list */
  outpoint: string;
  /** Price in satoshis */
  price: number;
  /** Address that receives payment on purchase (BRC-29 receive address) */
  payAddress: string;
}

export interface PurchaseOrdinalRequest {
  /** Outpoint of listing to purchase */
  outpoint: string;
  /** Marketplace address for fees */
  marketplaceAddress?: string;
  /** Marketplace fee rate (0-1) */
  marketplaceRate?: number;
  /** Optional content type - looked up from ordfs API if not provided */
  contentType?: string;
  /** Optional origin outpoint - looked up from ordfs API if not provided */
  origin?: string;
  /** Optional name from MAP metadata - looked up from ordfs API if not provided */
  name?: string;
}

export interface OrdinalOperationResponse {
  txid?: string;
  rawtx?: string;
  error?: string;
}

// ============================================================================
// Internal helpers
// ============================================================================

async function deriveCancelAddressInternal(
  ctx: OneSatContext,
  outpoint: string,
): Promise<string> {
  const result = await ctx.wallet.getPublicKey({
    protocolID: ONESAT_PROTOCOL,
    keyID: outpoint,
    forSelf: true,
  });
  return PublicKey.fromString(result.publicKey).toAddress();
}

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

function buildSerializedOutput(satoshis: number, script: number[]): number[] {
  const writer = new Utils.Writer();
  writer.writeUInt64LEBn(new BigNumber(satoshis));
  writer.writeVarIntNum(script.length);
  writer.write(script);
  return writer.toArray();
}

async function buildPurchaseUnlockingScript(
  tx: Transaction,
  inputIndex: number,
  sourceSatoshis: number,
  lockingScript: LockingScript,
): Promise<UnlockingScript> {
  if (tx.outputs.length < 2) {
    throw new Error("Malformed transaction: requires at least 2 outputs");
  }

  const script = new UnlockingScript().writeBin(
    buildSerializedOutput(tx.outputs[0].satoshis ?? 0, tx.outputs[0].lockingScript.toBinary()),
  );

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
    scope:
      TransactionSignature.SIGHASH_ALL |
      TransactionSignature.SIGHASH_ANYONECANPAY |
      TransactionSignature.SIGHASH_FORKID,
  });

  return script.writeBin(preimage).writeOpCode(OP.OP_0);
}

// ============================================================================
// Builder functions (utilities for advanced use)
// ============================================================================

/**
 * Build CreateActionArgs for transferring an ordinal.
 * Does NOT execute - returns params for createAction.
 */
export async function buildTransferOrdinal(
  ctx: OneSatContext,
  request: TransferOrdinalRequest,
): Promise<CreateActionArgs | { error: string }> {
  const { outpoint, counterparty, address, paymail } = request;

  if (!counterparty && !address && !paymail) {
    return { error: "must-provide-counterparty-address-or-paymail" };
  }

  let recipientAddress: string;
  if (counterparty) {
    const { publicKey } = await ctx.wallet.getPublicKey({
      protocolID: ONESAT_PROTOCOL,
      keyID: outpoint,
      counterparty,
      forSelf: false,
    });
    recipientAddress = PublicKey.fromString(publicKey).toAddress();
  } else if (paymail) {
    return { error: "paymail-not-yet-implemented" };
  } else {
    recipientAddress = address!;
  }

  const result = await ctx.wallet.listOutputs({
    basket: ORDINALS_BASKET,
    includeTags: true,
    includeCustomInstructions: true,
    include: "locking scripts",
    limit: 10000,
  });

  const sourceOutput = result.outputs.find((o) => o.outpoint === outpoint);
  if (!sourceOutput) {
    return { error: "ordinal-not-found" };
  }

  // Preserve important tags from source output
  const tags: string[] = [];
  for (const tag of sourceOutput.tags ?? []) {
    if (tag.startsWith("type:") || tag.startsWith("origin:") || tag.startsWith("name:")) {
      tags.push(tag);
    }
  }

  return {
    description: "Transfer ordinal",
    inputs: [{ outpoint, inputDescription: "Ordinal to transfer" }],
    outputs: [
      {
        lockingScript: new P2PKH().lock(recipientAddress).toHex(),
        satoshis: 1,
        outputDescription: "Ordinal transfer",
        basket: ORDINALS_BASKET,
        tags,
        customInstructions: JSON.stringify({
          protocolID: ONESAT_PROTOCOL,
          keyID: outpoint,
        }),
      },
    ],
  };
}

/**
 * Build CreateActionArgs for listing an ordinal for sale.
 * Does NOT execute - returns params for createAction.
 */
export async function buildListOrdinal(
  ctx: OneSatContext,
  request: ListOrdinalRequest,
): Promise<CreateActionArgs | { error: string }> {
  const { outpoint, price, payAddress } = request;

  if (!payAddress) return { error: "missing-pay-address" };
  if (price <= 0) return { error: "invalid-price" };

  const result = await ctx.wallet.listOutputs({
    basket: ORDINALS_BASKET,
    includeTags: true,
    include: "locking scripts",
    limit: 10000,
  });

  const sourceOutput = result.outputs.find((o) => o.outpoint === outpoint);
  if (!sourceOutput) {
    return { error: "ordinal-not-found" };
  }

  const typeTag = sourceOutput.tags?.find((t) => t.startsWith("type:"));
  const originTag = sourceOutput.tags?.find((t) => t.startsWith("origin:"));
  const nameTag = sourceOutput.tags?.find((t) => t.startsWith("name:"));
  const originOutpoint = originTag ? originTag.slice(7) : outpoint;

  const cancelAddress = await deriveCancelAddressInternal(ctx, outpoint);
  const lockingScript = buildOrdLockScript(cancelAddress, payAddress, price);

  const tags: string[] = ["ordlock", `origin:${originOutpoint}`, `price:${price}`];
  if (typeTag) tags.push(typeTag);
  if (nameTag) tags.push(nameTag);

  return {
    description: `List ordinal for ${price} sats`,
    inputs: [{ outpoint, inputDescription: "Ordinal to list" }],
    outputs: [
      {
        lockingScript: lockingScript.toHex(),
        satoshis: 1,
        outputDescription: `List ordinal for ${price} sats`,
        basket: ORDINALS_BASKET,
        tags,
        customInstructions: JSON.stringify({
          protocolID: ONESAT_PROTOCOL,
          keyID: outpoint,
        }),
      },
    ],
  };
}

// ============================================================================
// Skills
// ============================================================================

/** Input for listOrdinals skill */
export interface ListOrdinalsInput {
  /** Max number of ordinals to return */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
}

/**
 * List ordinals from the wallet.
 */
export const listOrdinals: Skill<ListOrdinalsInput, WalletOutput[]> = {
  meta: {
    name: "listOrdinals",
    description: "List ordinals/inscriptions from the wallet",
    category: "ordinals",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "integer", description: "Max number of ordinals to return (default: 100)" },
        offset: { type: "integer", description: "Offset for pagination (default: 0)" },
      },
    },
  },
  async execute(ctx, input) {
    const result = await ctx.wallet.listOutputs({
      basket: ORDINALS_BASKET,
      includeTags: true,
      includeCustomInstructions: true,
      limit: input.limit ?? 100,
      offset: input.offset ?? 0,
    });
    return result.outputs;
  },
};

/** Input for deriveCancelAddress skill */
export interface DeriveCancelAddressInput {
  /** Outpoint of the ordinal listing */
  outpoint: string;
}

/**
 * Derive a cancel address for an ordinal listing.
 */
export const deriveCancelAddress: Skill<DeriveCancelAddressInput, string> = {
  meta: {
    name: "deriveCancelAddress",
    description: "Derive the cancel address for an ordinal listing",
    category: "ordinals",
    inputSchema: {
      type: "object",
      properties: {
        outpoint: { type: "string", description: "Outpoint of the ordinal listing" },
      },
      required: ["outpoint"],
    },
  },
  async execute(ctx, input) {
    return deriveCancelAddressInternal(ctx, input.outpoint);
  },
};

/**
 * Transfer an ordinal to a new owner.
 */
export const transferOrdinal: Skill<TransferOrdinalRequest, OrdinalOperationResponse> = {
  meta: {
    name: "transferOrdinal",
    description: "Transfer an ordinal to a new owner via counterparty pubkey, address, or paymail",
    category: "ordinals",
    inputSchema: {
      type: "object",
      properties: {
        outpoint: { type: "string", description: "Outpoint of the ordinal (txid_vout format)" },
        counterparty: { type: "string", description: "Recipient identity public key (hex)" },
        address: { type: "string", description: "Recipient P2PKH address" },
        paymail: { type: "string", description: "Recipient paymail address" },
      },
      required: ["outpoint"],
    },
  },
  async execute(ctx, input) {
    try {
      const params = await buildTransferOrdinal(ctx, input);
      if ("error" in params) {
        return params;
      }

      const result = await ctx.wallet.createAction({
        ...params,
        options: { randomizeOutputs: false },
      });

      if (!result.txid) {
        return { error: "no-txid-returned" };
      }
      return { txid: result.txid, rawtx: result.tx ? Utils.toHex(result.tx) : undefined };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "unknown-error" };
    }
  },
};

/**
 * List an ordinal for sale on the global orderbook.
 */
export const listOrdinal: Skill<ListOrdinalRequest, OrdinalOperationResponse> = {
  meta: {
    name: "listOrdinal",
    description: "List an ordinal for sale on the global orderbook",
    category: "ordinals",
    inputSchema: {
      type: "object",
      properties: {
        outpoint: { type: "string", description: "Outpoint of the ordinal to list" },
        price: { type: "integer", description: "Price in satoshis" },
        payAddress: { type: "string", description: "Address to receive payment on purchase" },
      },
      required: ["outpoint", "price", "payAddress"],
    },
  },
  async execute(ctx, input) {
    try {
      const params = await buildListOrdinal(ctx, input);
      if ("error" in params) {
        return params;
      }

      const result = await ctx.wallet.createAction({
        ...params,
        options: { randomizeOutputs: false },
      });

      if (!result.txid) {
        return { error: "no-txid-returned" };
      }
      return { txid: result.txid, rawtx: result.tx ? Utils.toHex(result.tx) : undefined };
    } catch (error) {
      return { error: error instanceof Error ? error.message : "unknown-error" };
    }
  },
};

/** Input for cancelListing skill */
export interface CancelListingInput {
  /** Outpoint of the listing to cancel */
  outpoint: string;
}

/**
 * Cancel an ordinal listing.
 */
export const cancelListing: Skill<CancelListingInput, OrdinalOperationResponse> = {
  meta: {
    name: "cancelListing",
    description: "Cancel an ordinal listing and return the ordinal to the wallet",
    category: "ordinals",
    inputSchema: {
      type: "object",
      properties: {
        outpoint: { type: "string", description: "Outpoint of the listing to cancel" },
      },
      required: ["outpoint"],
    },
  },
  async execute(ctx, input) {
    try {
      const { outpoint } = input;

      const result = await ctx.wallet.listOutputs({
        basket: ORDINALS_BASKET,
        includeTags: true,
        includeCustomInstructions: true,
        include: "locking scripts",
        limit: 10000,
      });

      const listing = result.outputs.find((o) => o.outpoint === outpoint);
      if (!listing) {
        return { error: "listing-not-found" };
      }

      if (!listing.customInstructions) {
        return { error: "missing-custom-instructions" };
      }
      const { protocolID, keyID } = JSON.parse(listing.customInstructions);

      const typeTag = listing.tags?.find((t) => t.startsWith("type:"));
      const originTag = listing.tags?.find((t) => t.startsWith("origin:"));
      const nameTag = listing.tags?.find((t) => t.startsWith("name:"));

      const cancelAddress = await deriveCancelAddressInternal(ctx, keyID);

      const tags: string[] = [];
      if (typeTag) tags.push(typeTag);
      if (originTag) tags.push(originTag);
      if (nameTag) tags.push(nameTag);

      const createResult = await ctx.wallet.createAction({
        description: "Cancel ordinal listing",
        inputs: [
          {
            outpoint,
            inputDescription: "Listed ordinal",
            unlockingScriptLength: 108,
          },
        ],
        outputs: [
          {
            lockingScript: new P2PKH().lock(cancelAddress).toHex(),
            satoshis: 1,
            outputDescription: "Cancelled listing",
            basket: ORDINALS_BASKET,
            tags,
            customInstructions: JSON.stringify({ protocolID, keyID }),
          },
        ],
        options: { signAndProcess: false, randomizeOutputs: false },
      });

      if ("error" in createResult && createResult.error) {
        return { error: String(createResult.error) };
      }

      if (!createResult.signableTransaction) {
        return { error: "no-signable-transaction" };
      }

      const tx = Transaction.fromBEEF(createResult.signableTransaction.tx);
      const txInput = tx.inputs[0];
      const lockingScript = Script.fromHex(listing.lockingScript!);

      const sourceTXID = txInput.sourceTXID ?? txInput.sourceTransaction?.id("hex");
      if (!sourceTXID) {
        return { error: "missing-source-txid" };
      }

      const preimage = TransactionSignature.format({
        sourceTXID,
        sourceOutputIndex: txInput.sourceOutputIndex,
        sourceSatoshis: listing.satoshis,
        transactionVersion: tx.version,
        otherInputs: [],
        inputIndex: 0,
        outputs: tx.outputs,
        inputSequence: txInput.sequence ?? 0xffffffff,
        subscript: lockingScript,
        lockTime: tx.lockTime,
        scope:
          TransactionSignature.SIGHASH_ALL |
          TransactionSignature.SIGHASH_ANYONECANPAY |
          TransactionSignature.SIGHASH_FORKID,
      });

      const sighash = Hash.sha256(Hash.sha256(preimage));

      const { signature } = await ctx.wallet.createSignature({
        protocolID,
        keyID,
        counterparty: "self",
        hashToDirectlySign: Array.from(sighash),
      });

      const { publicKey } = await ctx.wallet.getPublicKey({
        protocolID,
        keyID,
        forSelf: true,
      });

      const unlockingScript = new UnlockingScript()
        .writeBin(signature)
        .writeBin(Utils.toArray(publicKey, "hex"))
        .writeOpCode(OP.OP_1);

      const signResult = await ctx.wallet.signAction({
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
  },
};

/**
 * Purchase an ordinal from the global orderbook.
 */
export const purchaseOrdinal: Skill<PurchaseOrdinalRequest, OrdinalOperationResponse> = {
  meta: {
    name: "purchaseOrdinal",
    description: "Purchase an ordinal from the global orderbook",
    category: "ordinals",
    requiresServices: true,
    inputSchema: {
      type: "object",
      properties: {
        outpoint: { type: "string", description: "Outpoint of the listing to purchase" },
        marketplaceAddress: { type: "string", description: "Marketplace address for fees" },
        marketplaceRate: { type: "number", description: "Marketplace fee rate (0-1)" },
        contentType: { type: "string", description: "Content type (auto-detected if not provided)" },
        origin: { type: "string", description: "Origin outpoint (auto-detected if not provided)" },
      },
      required: ["outpoint"],
    },
  },
  async execute(ctx, input) {
    try {
      const { outpoint, marketplaceAddress, marketplaceRate } = input;

      if (!ctx.services) {
        return { error: "services-required-for-purchase" };
      }

      const parts = outpoint.split("_");
      if (parts.length !== 2) {
        return { error: "invalid-outpoint-format" };
      }
      const [txid, voutStr] = parts;
      const vout = Number.parseInt(voutStr, 10);

      let { contentType, origin, name } = input;
      if (!contentType || !origin || name === undefined) {
        const metadata = await ctx.services.ordfs.getMetadata(outpoint);
        contentType = contentType ?? metadata.contentType;
        origin = origin ?? metadata.origin ?? outpoint;
        // Extract name from map.name or map.subTypeData.name
        if (name === undefined && metadata.map) {
          const mapName = metadata.map.name;
          const subTypeData = metadata.map.subTypeData as Record<string, unknown> | undefined;
          name = (typeof mapName === "string" ? mapName : undefined) ??
                 (typeof subTypeData?.name === "string" ? subTypeData.name : undefined);
        }
      }

      const beef = await ctx.services.getBeefForTxid(txid);
      const listingBeefTx = beef.findTxid(txid);
      if (!listingBeefTx?.tx) {
        return { error: "listing-transaction-not-found" };
      }

      const listingOutput = listingBeefTx.tx.outputs[vout];
      if (!listingOutput) {
        return { error: "listing-output-not-found" };
      }

      const ordLockData = OrdLock.decode(listingOutput.lockingScript);
      if (!ordLockData) {
        return { error: "not-an-ordlock-listing" };
      }

      const { publicKey } = await ctx.wallet.getPublicKey({
        protocolID: ONESAT_PROTOCOL,
        keyID: outpoint,
        counterparty: "self",
        forSelf: true,
      });
      const ourOrdAddress = PublicKey.fromString(publicKey).toAddress();

      const outputs: Array<{
        lockingScript: string;
        satoshis: number;
        outputDescription: string;
        basket?: string;
        tags?: string[];
        customInstructions?: string;
      }> = [];

      const p2pkh = new P2PKH();
      const purchaseTags = [`type:${contentType}`, `origin:${origin}`];
      if (name) purchaseTags.push(`name:${name}`);

      outputs.push({
        lockingScript: p2pkh.lock(ourOrdAddress).toHex(),
        satoshis: 1,
        outputDescription: "Purchased ordinal",
        basket: ORDINALS_BASKET,
        tags: purchaseTags,
        customInstructions: JSON.stringify({
          protocolID: ONESAT_PROTOCOL,
          keyID: outpoint,
        }),
      });

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

      const createResult = await ctx.wallet.createAction({
        description: `Purchase ordinal for ${payoutSatoshis} sats`,
        inputBEEF: beef.toBinary(),
        inputs: [
          {
            outpoint,
            inputDescription: "Listed ordinal",
            unlockingScriptLength: 500,
          },
        ],
        outputs,
        options: { signAndProcess: false, randomizeOutputs: false },
      });

      if ("error" in createResult && createResult.error) {
        return { error: String(createResult.error) };
      }

      if (!createResult.signableTransaction) {
        return { error: "no-signable-transaction" };
      }

      const tx = Transaction.fromBEEF(createResult.signableTransaction.tx);

      const unlockingScript = await buildPurchaseUnlockingScript(
        tx,
        0,
        listingOutput.satoshis ?? 1,
        listingOutput.lockingScript,
      );

      const signResult = await ctx.wallet.signAction({
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
  },
};

// ============================================================================
// Module exports
// ============================================================================

/** All ordinals skills for registry */
export const ordinalsSkills = [
  listOrdinals,
  deriveCancelAddress,
  transferOrdinal,
  listOrdinal,
  cancelListing,
  purchaseOrdinal,
];
