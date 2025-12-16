import { OP, Script, Utils } from "@bsv/sdk";
import { Inscription as InscriptionTemplate } from "@bsv/templates";
import { MapIndexer } from "./MapIndexer";
import { parseAddress } from "./parseAddress";
import { type IndexData, type IndexSummary, Indexer, type ParseContext } from "./types";

export interface File {
  hash: string;
  size: number;
  type: string;
  content: number[];
}

export interface Inscription {
  file?: File;
  fields?: { [key: string]: string };
  parent?: string;
}

/**
 * InscriptionIndexer identifies and parses ordinal inscriptions.
 * These are outputs with exactly 1 satoshi containing OP_FALSE OP_IF "ord" envelope.
 *
 * Data structure: Inscription with file, fields, and optional parent
 *
 * Basket: None (no basket assignment - this is preliminary data for other indexers)
 * Events: address for owned outputs
 */
export class InscriptionIndexer extends Indexer {
  tag = "insc";
  name = "Inscriptions";

  constructor(
    public owners = new Set<string>(),
    public network: "mainnet" | "testnet" = "mainnet",
  ) {
    super(owners, network);
  }

  async parse(ctx: ParseContext, vout: number): Promise<IndexData | undefined> {
    const txo = ctx.txos[vout];
    if (txo.satoshis !== 1n) return;

    const script = ctx.tx.outputs[vout].lockingScript;

    // Use template decode
    const decoded = InscriptionTemplate.decode(script);
    if (!decoded) return;

    // Extract owner from script prefix or suffix
    if (!txo.owner) {
      txo.owner = parseAddress(script, 0, this.network);
    }
    if (!txo.owner && decoded.scriptSuffix) {
      // Try to find owner in suffix (after OP_ENDIF)
      const suffixScript = Script.fromBinary(Array.from(decoded.scriptSuffix));
      txo.owner = parseAddress(suffixScript, 0, this.network);
      // Also check for OP_CODESEPARATOR pattern
      if (!txo.owner && suffixScript.chunks[0]?.op === OP.OP_CODESEPARATOR) {
        txo.owner = parseAddress(suffixScript, 1, this.network);
      }
    }

    // Handle MAP field if present (special case)
    if (decoded.fields?.has("MAP")) {
      const mapData = decoded.fields.get("MAP");
      if (mapData) {
        const map = MapIndexer.parseMap(Script.fromBinary(Array.from(mapData)), 0);
        if (map) {
          txo.data.map = { data: map, tags: [] };
        }
      }
    }

    // Convert to wallet-toolbox format
    const insc: Inscription = {
      file: {
        hash: Utils.toBase64(Array.from(decoded.file.hash)),
        size: decoded.file.size,
        type: decoded.file.type,
        content: Array.from(decoded.file.content),
      },
      fields: {},
    };

    // Convert parent outpoint to string format
    if (decoded.parent) {
      try {
        const reader = new Utils.Reader(Array.from(decoded.parent));
        const txid = Utils.toHex(reader.read(32).reverse());
        const vout = reader.readInt32LE();
        insc.parent = `${txid}_${vout}`;
      } catch {
        // Ignore parsing errors
      }
    }

    // Convert fields to base64 strings
    if (decoded.fields) {
      for (const [key, value] of decoded.fields) {
        if (key !== "MAP") {
          insc.fields![key] = Buffer.from(value).toString("base64");
        }
      }
    }

    return {
      data: insc,
      tags: [],
    };
  }

  async summerize(ctx: ParseContext): Promise<IndexSummary | undefined> {
    // Clear file content before saving - content is loaded locally but shouldn't be persisted
    for (const txo of ctx.txos) {
      const insc = txo.data[this.tag]?.data as Inscription | undefined;
      if (insc?.file) {
        insc.file.content = [];
      }
    }
    return undefined;
  }
}
