import type { ClientOptions } from "../types";
import { BaseClient } from "./BaseClient";

/**
 * Client for /api/beef/* routes.
 * Provides BEEF data, raw transactions, and merkle proofs.
 *
 * Routes:
 * - GET /:txid - Get BEEF for transaction
 * - GET /:txid/raw - Get raw transaction bytes
 * - GET /:txid/proof - Get merkle proof
 */
export class BeefClient extends BaseClient {
  constructor(baseUrl: string, options: ClientOptions = {}) {
    super(baseUrl, options);
  }

  /**
   * Get BEEF (Background Evaluation Extended Format) for a transaction
   */
  async getBeef(txid: string): Promise<Uint8Array> {
    return this.requestBinary(`/${txid}`);
  }

  /**
   * Get raw transaction bytes
   */
  async getRaw(txid: string): Promise<Uint8Array> {
    return this.requestBinary(`/${txid}/raw`);
  }

  /**
   * Get merkle proof bytes for a mined transaction
   */
  async getProof(txid: string): Promise<Uint8Array> {
    return this.requestBinary(`/${txid}/proof`);
  }
}
