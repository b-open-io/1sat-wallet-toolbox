import { HD, Hash, Utils } from "@bsv/sdk";
import { BSV21 } from "@bopen-io/ts-templates";
import { HttpError } from "../errors";
import type { OneSatServices } from "../services/OneSatServices";
import {
  type IndexSummary,
  Indexer,
  type ParseContext,
  type ParseResult,
  type Txo,
} from "./types";

const FEE_XPUB =
  "xpub661MyMwAqRbcF221R74MPqdipLsgUevAAX4hZP2rywyEeShpbe3v2r9ciAvSGT6FB22TEmFLdUyeEDJL4ekG8s9H5WXbzDQPr6eW1zEYYy9";
const hdKey = HD.fromString(FEE_XPUB);

export interface Bsv21 {
  id: string;
  op: string;
  amt: bigint;
  dec: number;
  sym?: string;
  icon?: string;
  status: "valid" | "invalid" | "pending";
  reason?: string;
  fundAddress: string;
}

/**
 * Bsv21Indexer identifies and validates BSV21 tokens.
 * These are 1-sat outputs with application/bsv-20 inscription type.
 *
 * Data structure: Bsv21 with id, op, amt, dec, status, etc.
 *
 * Basket: 'bsv21'
 * Events: id, id:status, bsv21:amt
 */
export class Bsv21Indexer extends Indexer {
  tag = "bsv21";
  name = "BSV21 Tokens";

  constructor(
    public owners: Set<string>,
    public network: "mainnet" | "testnet",
    public services: OneSatServices,
  ) {
    super(owners, network);
  }

  async parse(txo: Txo): Promise<ParseResult | undefined> {
    const lockingScript = txo.output.lockingScript;

    // Use template decode
    const decoded = BSV21.decode(lockingScript);
    if (!decoded) return;

    const outpoint = txo.outpoint;
    const tokenData = decoded.tokenData;

    // Create indexer data structure
    const bsv21: Bsv21 = {
      id: tokenData.id || outpoint.toString(),
      op: tokenData.op,
      amt: decoded.getAmount(),
      dec: decoded.getDecimals(),
      sym: tokenData.sym,
      icon: tokenData.icon,
      status: tokenData.op === "deploy+mint" ? "valid" : "pending",
      fundAddress: deriveFundAddress(outpoint.toBEBinary()),
    };

    // Validate amount range
    if (bsv21.amt <= 0n || bsv21.amt > 2n ** 64n - 1n) return;

    const tags: string[] = [];
    if (txo.owner && this.owners.has(txo.owner)) {
      tags.push(`id:${bsv21.id}`);
      tags.push(`id:${bsv21.id}:${bsv21.status}`);
      tags.push(`amt:${bsv21.amt.toString()}`);
    }

    return {
      data: bsv21,
      tags,
      basket: "bsv21",
    };
  }

  async summarize(ctx: ParseContext): Promise<IndexSummary | undefined> {
    const tokens: {
      [id: string]: {
        sym?: string;
        icon?: string;
        dec: number;
        status?: "valid" | "invalid" | "pending";
        tokensIn: bigint;
        tokensOut: bigint;
      };
    } = {};
    let summaryToken: Bsv21 | undefined;
    let summaryBalance = 0;

    // Process inputs from ctx.spends (already parsed)
    for (const spend of ctx.spends) {
      const bsv21 = spend.data.bsv21;
      if (!bsv21) continue;

      const tokenData = bsv21.data as Bsv21;

      // Initialize token tracking if this is the first time we see this token
      if (!tokens[tokenData.id]) {
        tokens[tokenData.id] = {
          sym: undefined,
          icon: undefined,
          dec: 0,
          status: undefined,
          tokensIn: 0n,
          tokensOut: 0n,
        };
      }

      const token = tokens[tokenData.id];

      // Validate this specific input against the overlay
      try {
        const overlayData = await this.services.bsv21.getTokenByTxid(
          tokenData.id,
          spend.outpoint.txid,
        );
        const outputData = overlayData.outputs.find(
          (o) => o.vout === spend.outpoint.vout,
        );
        const bsv21OverlayData = outputData?.data.bsv21;

        // Set token metadata from overlay (only the first time we get valid overlay data)
        if (token.sym === undefined) {
          token.sym = bsv21OverlayData?.sym;
          token.icon = bsv21OverlayData?.icon;
          token.dec = bsv21OverlayData?.dec || 0;
        }
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) {
          // Overlay doesn't have this input - mark as pending
          token.status = "pending";
        } else {
          throw e;
        }
      }

      // Accumulate tokens in
      token.tokensIn += tokenData.amt;

      if (!summaryToken) summaryToken = tokenData;

      // Check if this input is owned by us
      if (
        summaryToken &&
        tokenData.id === summaryToken.id &&
        spend.owner &&
        this.owners.has(spend.owner)
      ) {
        summaryBalance -= Number(tokenData.amt);
      }
    }

    // Process outputs: accumulate tokensOut
    for (const txo of ctx.txos) {
      const bsv21 = txo.data.bsv21;
      if (!bsv21 || !["transfer", "burn"].includes((bsv21.data as Bsv21).op))
        continue;

      const tokenData = bsv21.data as Bsv21;
      const token = tokens[tokenData.id];

      if (token) {
        token.tokensOut += tokenData.amt;
        tokenData.sym = token.sym;
        tokenData.icon = token.icon;
        tokenData.dec = token.dec;
      } else {
        // No inputs for this token - attempting to spend tokens that don't exist
        tokenData.status = "invalid";
      }

      if (!summaryToken) summaryToken = tokenData;
      if (
        summaryToken &&
        tokenData.id === summaryToken.id &&
        txo.owner &&
        this.owners.has(txo.owner)
      ) {
        summaryBalance += Number(tokenData.amt);
      }
    }

    // Finalize token validation: check that tokensIn >= tokensOut
    for (const tokenId in tokens) {
      const token = tokens[tokenId];
      if (token.status === undefined) {
        if (token.tokensIn >= token.tokensOut) {
          token.status = "valid";
        } else {
          token.status = "invalid";
        }
      }
    }

    // Apply token metadata and status to outputs
    for (const txo of ctx.txos) {
      const bsv21 = txo.data.bsv21;
      if (!bsv21 || !["transfer", "burn"].includes((bsv21.data as Bsv21).op))
        continue;

      const tokenData = bsv21.data as Bsv21;
      const token = tokens[tokenData.id];

      if (token) {
        tokenData.status = token.status || "pending";
      }
    }

    if (summaryToken?.sym) {
      return {
        id: summaryToken.sym,
        amount: summaryBalance / 10 ** (summaryToken.dec || 0),
        icon: summaryToken.icon,
      };
    }
  }

  serialize(bsv21: Bsv21): string {
    return JSON.stringify({
      ...bsv21,
      amt: bsv21.amt.toString(10),
    });
  }

  deserialize(str: string): Bsv21 {
    const obj = JSON.parse(str);
    return {
      ...obj,
      amt: BigInt(obj.amt),
    };
  }
}

export function deriveFundAddress(idOrOutpoint: string | number[]): string {
  const hash = Hash.sha256(idOrOutpoint);
  const reader = new Utils.Reader(hash);
  let path = `m/21/${reader.readUInt32BE() >> 1}`;
  reader.pos = 24;
  path += `/${reader.readUInt32BE() >> 1}`;
  return hdKey.derive(path).pubKey.toAddress();
}
