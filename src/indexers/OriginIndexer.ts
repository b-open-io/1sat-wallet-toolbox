import {
  Indexer,
  type IndexData,
  type ParseContext,
  type IndexSummary,
} from "./types";
import type { Inscription } from "./InscriptionIndexer";
import type { Sigma } from "./SigmaIndexer";
import type { OneSatServices } from "../services/OneSatServices";
import { HttpError } from "../errors";

export interface Origin {
  outpoint?: string;
  nonce?: number;
  insc?: Inscription;
  map?: { [key: string]: unknown };
  sigma?: Sigma[];
}

export class OriginIndexer extends Indexer {
  tag = "origin";
  name = "Origins";

  constructor(
    public owners = new Set<string>(),
    public network: "mainnet" | "testnet" = "mainnet",
    private services: OneSatServices
  ) {
    super(owners, network);
  }

  async parse(ctx: ParseContext, vout: number): Promise<IndexData | undefined> {
    const txo = ctx.txos[vout];

    // Only parse 1-satoshi outputs, exclude BSV-20 tokens
    if (txo.satoshis !== 1n) return;
    const insc = txo.data.insc?.data as Inscription | undefined;
    if (insc?.file?.type === "application/bsv-20") return;

    // Calculate the satoshi position for this output
    let outSat = 0n;
    for (let i = 0; i < vout; i++) {
      outSat += ctx.txos[i].satoshis;
    }

    // Start with empty origin
    let origin: Origin = {
      outpoint: "",
      nonce: 0,
      sigma: txo.data.sigma?.data as Sigma[],
    };

    // Track accumulated input satoshis to find which input contains our satoshi
    let satsIn = 0n;
    let sourceOutpoint: string | undefined;

    for (const spend of ctx.spends) {
      // Check if this input's satoshi range contains our output's satoshi
      if (satsIn === outSat && spend.satoshis === 1n) {
        sourceOutpoint = spend.outpoint.toString();
        break;
      }

      satsIn += spend.satoshis;

      // If we've passed our satoshi position, this is a new origin
      if (satsIn > outSat) {
        break;
      }
    }

    if (sourceOutpoint) {
      // Transfer - fetch metadata from OrdFS
      try {
        const metadata = await this.services.getOrdfsMetadata(sourceOutpoint);
        origin.outpoint = metadata.origin || sourceOutpoint;
        origin.nonce = metadata.sequence + 1;
        origin.map = metadata.map;
        origin.insc = {
          file: {
            hash: "",
            size: metadata.contentLength,
            type: metadata.contentType,
            content: [],
          },
        };
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) {
          // Source outpoint not found in OrdFS - cannot determine origin
          return;
        }
        throw e;
      }
    } else {
      // New origin
      origin.outpoint = txo.outpoint.toString();
    }

    // Merge current output's MAP data with inherited
    const currentMap = txo.data.map?.data as { [key: string]: unknown } | undefined;
    if (currentMap) {
      origin.map = { ...(origin.map || {}), ...currentMap };
    }

    // If current output has inscription, use it
    if (insc) {
      origin.insc = insc;

      // Validate parent if inscription claims one
      if (insc.parent) {
        try {
          const metadata = await this.services.getOrdfsMetadata(
            txo.outpoint.toString()
          );
          if (metadata.parent !== insc.parent) {
            delete origin.insc.parent;
          }
        } catch (e) {
          if (e instanceof HttpError && e.status === 404) {
            // Can't verify parent claim - remove it
            delete origin.insc.parent;
          } else {
            throw e;
          }
        }
      }
    }

    // Clear large file content to save space
    if (origin.insc?.file?.size && origin.insc.file.size > 4096) {
      origin.insc.file.content = [];
    }

    const tags: string[] = [];
    if (txo.owner && this.owners.has(txo.owner)) {
      tags.push(`origin:${origin.outpoint || ""}`);
      if (origin.insc?.file?.type) {
        tags.push("type");
        tags.push(`type:${origin.insc.file.type.split("/")[0]}`);
        tags.push(`type:${origin.insc.file.type}`);
      }
    }

    // Set basket for 1sat ordinals
    txo.basket = "1sat";

    return {
      data: origin,
      tags,
    };
  }

  async summerize(ctx: ParseContext): Promise<IndexSummary | undefined> {
    let balance = 0;
    let hasTag = false;
    let icon: string | undefined;
    let id = "";

    // Check inputs
    for (const spend of ctx.spends) {
      if (spend.data[this.tag]) {
        const origin = spend.data[this.tag].data as Origin;
        if (spend.owner && this.owners.has(spend.owner)) {
          hasTag = true;
          balance--;
          if (!icon && origin?.insc?.file?.type.startsWith("image/")) {
            icon = origin?.outpoint;
            id = (origin.map?.name as string) || "";
          }
        }
      }
    }

    // Check outputs
    for (const txo of ctx.txos) {
      if (txo.data[this.tag]) {
        if (txo.owner && this.owners.has(txo.owner)) {
          hasTag = true;
          balance++;
          const origin = txo.data.origin?.data as Origin;
          if (!icon && origin?.insc?.file?.type.startsWith("image/")) {
            icon = origin?.outpoint;
          }
        }
      }
    }

    if (hasTag) {
      return {
        id,
        amount: balance,
        icon,
      };
    }
  }
}
