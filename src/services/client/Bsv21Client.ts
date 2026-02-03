import type {
  Bsv21TransactionData,
  ClientOptions,
  IndexedOutput,
  TokenDetailResponse,
} from "../types";
import { BaseClient } from "./BaseClient";

/**
 * Client for /1sat/bsv21/* routes.
 * Provides BSV21 token queries.
 *
 * Routes:
 * - POST /lookup - Bulk lookup token details with funding status
 * - GET /:tokenId - Get token details with funding status
 * - GET /:tokenId/tx/:txid - Get token transaction data
 * - GET /:tokenId/:lockType/:address/balance - Get token balance
 * - GET /:tokenId/:lockType/:address/unspent - Get unspent token UTXOs
 * - GET /:tokenId/:lockType/:address/history - Get token transaction history
 * - POST /:tokenId/:lockType/balance - Multi-address token balance
 * - POST /:tokenId/:lockType/unspent - Multi-address unspent token UTXOs
 * - POST /:tokenId/:lockType/history - Multi-address token transaction history
 */
export class Bsv21Client extends BaseClient {
  private cache = new Map<string, TokenDetailResponse>();

  constructor(baseUrl: string, options: ClientOptions = {}) {
    super(`${baseUrl}/1sat/bsv21`, options);
  }

  /**
   * Bulk lookup token details with funding status.
   * Returns details and active status for multiple tokens in one request.
   * @param tokenIds - Array of token IDs (max 100)
   */
  async lookupTokens(tokenIds: string[]): Promise<TokenDetailResponse[]> {
    return this.request<TokenDetailResponse[]>("/lookup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tokenIds),
    });
  }

  /**
   * Get token details with funding status.
   * Results are cached since token deploy data is immutable.
   */
  async getTokenDetails(tokenId: string): Promise<TokenDetailResponse> {
    const cached = this.cache.get(tokenId);
    if (cached) return cached;

    const details = await this.request<TokenDetailResponse>(`/${tokenId}`);
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
   */
  async getBalance(
    tokenId: string,
    lockType: string,
    address: string,
  ): Promise<{ balance: number; utxoCount: number }> {
    return this.request<{ balance: number; utxoCount: number }>(
      `/${tokenId}/${lockType}/${address}/balance`,
    );
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
   * Get token balance for multiple addresses
   * @param addresses - Array of addresses (max 100)
   */
  async getBalanceMulti(
    tokenId: string,
    lockType: string,
    addresses: string[],
  ): Promise<{ balance: number; utxoCount: number }> {
    return this.request<{ balance: number; utxoCount: number }>(
      `/${tokenId}/${lockType}/balance`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(addresses),
      },
    );
  }

  /**
   * Get unspent token UTXOs for multiple addresses
   * @param addresses - Array of addresses (max 100)
   */
  async getUnspentMulti(
    tokenId: string,
    lockType: string,
    addresses: string[],
  ): Promise<IndexedOutput[]> {
    return this.request<IndexedOutput[]>(`/${tokenId}/${lockType}/unspent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(addresses),
    });
  }

  /**
   * Get token transaction history for multiple addresses
   * @param addresses - Array of addresses (max 100)
   */
  async getHistoryMulti(
    tokenId: string,
    lockType: string,
    addresses: string[],
  ): Promise<IndexedOutput[]> {
    return this.request<IndexedOutput[]>(`/${tokenId}/${lockType}/history`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(addresses),
    });
  }

  /**
   * Clear the token details cache
   */
  clearCache(): void {
    this.cache.clear();
  }
}
