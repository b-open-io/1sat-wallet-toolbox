import { Cosign } from "@bsv/templates";
import { Indexer, type ParseResult, type Txo } from "./types";

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

  async parse(txo: Txo): Promise<ParseResult | undefined> {
    const lockingScript = txo.output.lockingScript;

    // Use template decode
    const decoded = Cosign.decode(lockingScript, this.network === "mainnet");
    if (!decoded) return;

    return {
      data: decoded as CosignData,
      tags: [],
      owner: decoded.address,
    };
  }
}
