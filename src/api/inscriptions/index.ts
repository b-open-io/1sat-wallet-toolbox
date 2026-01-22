/**
 * Inscriptions Module
 *
 * Skills for creating inscriptions.
 */

import { P2PKH, PublicKey, Script, Utils } from "@bsv/sdk";
import { Inscription } from "@bopen-io/templates";
import type { Skill } from "../skills/types";
import { MAX_INSCRIPTION_BYTES, ORDINALS_BASKET, ONESAT_PROTOCOL } from "../constants";

// ============================================================================
// Types
// ============================================================================

export interface InscribeRequest {
  /** Base64 encoded content */
  base64Content: string;
  /** Content type (MIME type) */
  contentType: string;
  /** Optional MAP metadata */
  map?: Record<string, string>;
}

export interface InscribeResponse {
  txid?: string;
  rawtx?: string;
  error?: string;
}

// ============================================================================
// Internal helpers
// ============================================================================

function buildInscriptionScript(address: string, base64Content: string, contentType: string): Script {
  const content = Utils.toArray(base64Content, "base64");
  const inscription = Inscription.create(new Uint8Array(content), contentType);
  const inscriptionScript = inscription.lock();
  const p2pkhScript = new P2PKH().lock(address);

  const combined = new Script();
  for (const chunk of inscriptionScript.chunks) combined.chunks.push(chunk);
  for (const chunk of p2pkhScript.chunks) combined.chunks.push(chunk);
  return combined;
}

// ============================================================================
// Skills
// ============================================================================

/**
 * Create an inscription.
 */
export const inscribe: Skill<InscribeRequest, InscribeResponse> = {
  meta: {
    name: "inscribe",
    description: "Create a new inscription with the given content and type",
    category: "inscriptions",
    inputSchema: {
      type: "object",
      properties: {
        base64Content: { type: "string", description: "Base64 encoded content" },
        contentType: { type: "string", description: "Content type (MIME type)" },
        map: {
          type: "object",
          description: "Optional MAP metadata",
          properties: {},
        },
      },
      required: ["base64Content", "contentType"],
    },
  },
  async execute(ctx, input) {
    try {
      const decoded = Utils.toArray(input.base64Content, "base64");
      if (decoded.length > MAX_INSCRIPTION_BYTES) {
        return { error: `Inscription data too large: ${decoded.length} bytes (max ${MAX_INSCRIPTION_BYTES})` };
      }

      const keyID = Date.now().toString();
      const { publicKey } = await ctx.wallet.getPublicKey({
        protocolID: ONESAT_PROTOCOL,
        keyID,
        counterparty: "self",
        forSelf: true,
      });
      const address = PublicKey.fromString(publicKey).toAddress();

      const lockingScript = buildInscriptionScript(address, input.base64Content, input.contentType);

      const result = await ctx.wallet.createAction({
        description: "Create inscription",
        outputs: [
          {
            lockingScript: lockingScript.toHex(),
            satoshis: 1,
            outputDescription: "Inscription",
            basket: ORDINALS_BASKET,
            tags: [`type:${input.contentType}`],
            customInstructions: JSON.stringify({
              protocolID: ONESAT_PROTOCOL,
              keyID,
            }),
          },
        ],
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

// ============================================================================
// Module exports
// ============================================================================

/** All inscription skills for registry */
export const inscriptionsSkills = [inscribe];
