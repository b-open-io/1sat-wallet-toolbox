/**
 * Signing Module
 *
 * Functions for message signing and transaction signatures.
 */

import {
  BigNumber,
  BSM,
  PublicKey,
  Signature,
  Utils,
  type WalletInterface,
} from "@bsv/sdk";
import { MESSAGE_SIGNING_PROTOCOL } from "../constants";

export interface SignMessageRequest {
  /** Message to sign */
  message: string;
  /** Message encoding */
  encoding?: "utf8" | "hex" | "base64";
  /** Derivation tag for key selection */
  tag?: {
    label: string;
    id: string;
    domain: string;
    meta: Record<string, string>;
  };
}

export interface SignedMessage {
  address: string;
  pubKey: string;
  message: string;
  sig: string;
  derivationTag?: SignMessageRequest["tag"];
}

export interface SignatureRequest {
  prevTxid: string;
  outputIndex: number;
  inputIndex: number;
  satoshis: number;
  script?: string;
  sigHashType?: number;
  csIdx?: number;
  address: string | string[];
}

export interface GetSignaturesRequest {
  rawtx: string;
  sigRequests: SignatureRequest[];
  format?: "tx" | "beef" | "ef";
}

export interface SignatureResponse {
  sig: string;
  pubKey: string;
  inputIndex: number;
  sigHashType: number;
  csIdx?: number;
}

/**
 * Sign a message using BSM (Bitcoin Signed Message) format.
 */
export async function signMessage(
  cwi: WalletInterface,
  request: SignMessageRequest
): Promise<SignedMessage | { error: string }> {
  try {
    const { message, encoding = "utf8", tag } = request;
    const messageBytes = Utils.toArray(message, encoding);
    const msgHash = BSM.magicHash(messageBytes);
    const keyID = tag ? `${tag.label}:${tag.id}:${tag.domain}` : "identity";

    const result = await cwi.createSignature({
      protocolID: MESSAGE_SIGNING_PROTOCOL,
      keyID,
      hashToDirectlySign: Array.from(msgHash),
    });

    const pubKeyResult = await cwi.getPublicKey({
      protocolID: MESSAGE_SIGNING_PROTOCOL,
      keyID,
      forSelf: true,
    });

    const publicKey = PublicKey.fromString(pubKeyResult.publicKey);
    const signature = Signature.fromDER(result.signature);
    const recovery = signature.CalculateRecoveryFactor(publicKey, new BigNumber(msgHash));

    return {
      address: publicKey.toAddress(),
      pubKey: publicKey.toString(),
      message,
      sig: signature.toCompact(recovery, true, "base64") as string,
      derivationTag: tag,
    };
  } catch (error) {
    return { error: error instanceof Error ? error.message : "unknown-error" };
  }
}

/**
 * Get signatures for transaction inputs.
 * TODO: Implement signature generation
 */
export async function getSignatures(
  _cwi: WalletInterface,
  _request: GetSignaturesRequest
): Promise<{ sigResponses?: SignatureResponse[]; error?: { message: string } }> {
  return { error: { message: "not-implemented" } };
}
