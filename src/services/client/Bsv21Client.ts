import type {
  Bsv21TokenDetails,
  Bsv21TransactionData,
  ClientOptions,
  IndexedOutput,
} from "../types";
import { BaseClient } from "./BaseClient";

/**
 * Client for /api/bsv21/* routes.
 * Provides BSV21 token queries.
 *
 * Routes:
 * - GET /:tokenId - Get token details
 * - GET /:tokenId/blk/:height - Get token data at block height
 * - GET /:tokenId/tx/:txid - Get token data for transaction
 * - GET /:tokenId/:lockType/:address/balance - Get token balance
 * - GET /:tokenId/:lockType/:address/unspent - Get unspent token UTXOs
 * - GET /:tokenId/:lockType/:address/history - Get token transaction history
 */
export class Bsv21Client extends BaseClient {
  private cache = new Map<string, Bsv21TokenDetails>();

  constructor(baseUrl: string, options: ClientOptions = {}) {
    super(`${baseUrl}/api/bsv21`, options);
  }

  /**
   * Get token details (deploy data).
   * Results are cached since token details are immutable.
   */
  async getTokenDetails(tokenId: string): Promise<Bsv21TokenDetails> {
    const cached = this.cache.get(tokenId);
    if (cached) return cached;

    const details = await this.request<Bsv21TokenDetails>(`/${tokenId}`);
    this.cache.set(tokenId, details);
    return details;
  }

  /**
   * Get token transaction data for a specific txid
   */
  async getTokenByTxid(
    tokenId: string,
    txid: string,
  ): Promise<Bsv21TransactionData> {
    return this.request<Bsv21TransactionData>(`/${tokenId}/tx/${txid}`);
  }

  /**
   * Get token balance for an address
   * @param tokenId - Token ID (outpoint of deploy tx)
   * @param lockType - Lock type (e.g., 'p2pkh', 'ordlock')
   * @param address - Address to check
   */
  async getBalance(
    tokenId: string,
    lockType: string,
    address: string,
  ): Promise<bigint> {
    const data = await this.request<{ balance: string }>(
      `/${tokenId}/${lockType}/${address}/balance`,
    );
    return BigInt(data.balance);
  }

  /**
   * Get unspent token UTXOs for an address
   */
  async getUnspent(
    tokenId: string,
    lockType: string,
    address: string,
  ): Promise<IndexedOutput[]> {
    return this.request<IndexedOutput[]>(
      `/${tokenId}/${lockType}/${address}/unspent`,
    );
  }

  /**
   * Get token transaction history for an address
   */
  async getHistory(
    tokenId: string,
    lockType: string,
    address: string,
  ): Promise<IndexedOutput[]> {
    return this.request<IndexedOutput[]>(
      `/${tokenId}/${lockType}/${address}/history`,
    );
  }

  /**
   * Clear the token details cache
   */
  clearCache(): void {
    this.cache.clear();
  }
}
