import { Cosign } from "@bsv/templates";
import { type IndexData, Indexer, type ParseContext } from "./types";

export interface CosignData {
  address: string;
  cosigner: string;
}

export class CosignIndexer extends Indexer {
  tag = "cosign";
  name = "Cosign";

  constructor(
    public owners = new Set<string>(),
    public network: "mainnet" | "testnet" = "mainnet",
  ) {
    super(owners, network);
  }

  async parse(ctx: ParseContext, vout: number): Promise<IndexData | undefined> {
    const txo = ctx.txos[vout];
    const lockingScript = ctx.tx.outputs[vout].lockingScript;

    // Use template decode
    const decoded = Cosign.decode(lockingScript, this.network === "mainnet");
    if (!decoded) return;

    txo.owner = decoded.address;

    return {
      data: decoded as CosignData,
      tags: [],
    };
  }
}
