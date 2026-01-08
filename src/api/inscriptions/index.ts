/**
 * Inscriptions Module
 *
 * Functions for creating inscriptions.
 */

import {
  P2PKH,
  Script,
  Utils,
  type WalletInterface,
} from "@bsv/sdk";
import { Inscription } from "@bopen-io/templates";
import { MAX_INSCRIPTION_BYTES } from "../constants";

export interface InscribeRequest {
  /** Base64 encoded data */
  base64Data: string;
  /** MIME type of the content */
  mimeType: string;
  /** Optional MAP metadata */
  map?: Record<string, string>;
  /** Destination address for the inscription (required - use a derived address) */
  destination: string;
}

export interface InscribeResponse {
  txid?: string;
  rawtx?: string;
  error?: string;
}

/**
 * Build an inscription locking script.
 */
function buildInscriptionScript(address: string, base64Data: string, mimeType: string): Script {
  const content = Utils.toArray(base64Data, "base64");
  const inscription = Inscription.create(new Uint8Array(content), mimeType);
  const inscriptionScript = inscription.lock();
  const p2pkhScript = new P2PKH().lock(address);

  const combined = new Script();
  for (const chunk of inscriptionScript.chunks) combined.chunks.push(chunk);
  for (const chunk of p2pkhScript.chunks) combined.chunks.push(chunk);
  return combined;
}

/**
 * Create an inscription.
 */
export async function inscribe(
  cwi: WalletInterface,
  request: InscribeRequest
): Promise<InscribeResponse> {
  try {
    const decoded = Buffer.from(request.base64Data, "base64");
    if (decoded.length > MAX_INSCRIPTION_BYTES) {
      return { error: `Inscription data too large: ${decoded.length} bytes (max ${MAX_INSCRIPTION_BYTES})` };
    }

    const lockingScript = buildInscriptionScript(request.destination, request.base64Data, request.mimeType);

    const result = await cwi.createAction({
      description: "Create inscription",
      outputs: [{
        lockingScript: lockingScript.toHex(),
        satoshis: 1,
        outputDescription: "Inscription",
      }],
    });

    if (!result.txid) {
      return { error: "no-txid-returned" };
    }
    return { txid: result.txid, rawtx: result.tx ? Utils.toHex(result.tx) : undefined };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "unknown-error" };
  }
}
