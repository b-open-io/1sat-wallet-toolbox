import { Lock } from "@bsv/templates";
import {
  type IndexData,
  type IndexSummary,
  Indexer,
  type ParseContext,
} from "./types";

export interface LockData {
  until: number;
}

export class LockIndexer extends Indexer {
  tag = "lock";
  name = "Locks";

  async parse(ctx: ParseContext, vout: number): Promise<IndexData | undefined> {
    const txo = ctx.txos[vout];
    const lockingScript = ctx.tx.outputs[vout].lockingScript;

    const decoded = Lock.decode(lockingScript, this.network === "mainnet");
    if (!decoded) return;

    txo.owner = decoded.address;
    txo.basket = "lock";

    return {
      data: { until: decoded.until } as LockData,
      tags: [],
    };
  }

  async summerize(ctx: ParseContext): Promise<IndexSummary | undefined> {
    let locksOut = 0n;
    for (const spend of ctx.spends) {
      if (spend.data[this.tag]) {
        locksOut +=
          spend.owner && this.owners.has(spend.owner) ? spend.satoshis : 0n;
      }
    }

    let locksIn = 0n;
    for (const txo of ctx.txos) {
      if (txo.data[this.tag]) {
        locksIn += txo.owner && this.owners.has(txo.owner) ? txo.satoshis : 0n;
      }
    }

    const balance = Number(locksIn - locksOut);
    if (balance) {
      return { amount: balance };
    }
  }
}
