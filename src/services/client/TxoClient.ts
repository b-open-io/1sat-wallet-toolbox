import type {
  ClientOptions,
  IndexedOutput,
  SearchRequest,
  SpendResponse,
  TxoQueryOptions,
} from "../types";
import { BaseClient } from "./BaseClient";

/**
 * Client for /api/txo/* routes.
 * Provides TXO (transaction output) lookup and search.
 *
 * Routes:
 * - GET /outpoint/:outpoint - Get single TXO
 * - GET /outpoint/:outpoint/spend - Get spend info
 * - POST /outpoints - Get multiple TXOs
 * - POST /outpoints/spends - Get multiple spends
 * - GET /tx/:txid - Get all TXOs for a transaction
 * - GET /search/:key - Search by single key
 * - POST /search - Search by multiple keys
 */
export class TxoClient extends BaseClient {
  constructor(baseUrl: string, options: ClientOptions = {}) {
    super(`${baseUrl}/api/txo`, options);
  }

  /**
   * Get a single TXO by outpoint
   */
  async get(outpoint: string, opts?: TxoQueryOptions): Promise<IndexedOutput> {
    const qs = this.buildQueryString({
      tags: opts?.tags,
    });
    return this.request<IndexedOutput>(`/outpoint/${outpoint}${qs}`);
  }

  /**
   * Get multiple TXOs by outpoints
   */
  async getBatch(
    outpoints: string[],
    opts?: TxoQueryOptions,
  ): Promise<(IndexedOutput | null)[]> {
    const qs = this.buildQueryString({
      tags: opts?.tags,
    });
    return this.request<(IndexedOutput | null)[]>(`/outpoints${qs}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outpoints),
    });
  }

  /**
   * Get spend info for an outpoint
   */
  async getSpend(outpoint: string): Promise<string | null> {
    const resp = await this.request<SpendResponse>(
      `/outpoint/${outpoint}/spend`,
    );
    return resp.spendTxid;
  }

  /**
   * Get spend info for multiple outpoints
   */
  async getSpends(outpoints: string[]): Promise<(string | null)[]> {
    const resp = await this.request<SpendResponse[]>("/outpoints/spends", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(outpoints),
    });
    return resp.map((r) => r.spendTxid);
  }

  /**
   * Get all TXOs for a transaction
   */
  async getByTxid(
    txid: string,
    opts?: TxoQueryOptions,
  ): Promise<IndexedOutput[]> {
    const qs = this.buildQueryString({
      tags: opts?.tags,
    });
    return this.request<IndexedOutput[]>(`/tx/${txid}${qs}`);
  }

  /**
   * Search TXOs by a single key
   */
  async search(key: string, opts?: TxoQueryOptions): Promise<IndexedOutput[]> {
    const qs = this.buildQueryString({
      tags: opts?.tags,
      from: opts?.from,
      limit: opts?.limit,
      rev: opts?.rev,
      unspent: opts?.unspent,
    });
    return this.request<IndexedOutput[]>(
      `/search/${encodeURIComponent(key)}${qs}`,
    );
  }

  /**
   * Search TXOs by multiple keys
   */
  async searchMultiple(req: SearchRequest): Promise<IndexedOutput[]> {
    return this.request<IndexedOutput[]>("/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
  }
}
