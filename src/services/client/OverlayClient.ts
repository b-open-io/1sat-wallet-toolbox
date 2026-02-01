import type { ClientOptions } from "../types";
import { BaseClient } from "./BaseClient";

/** Topic manager metadata returned by listTopicManagers */
export interface TopicManagerInfo {
  name?: string;
  description?: string;
  icon?: string;
  [key: string]: unknown;
}

/** Lookup service provider metadata returned by listLookupServiceProviders */
export interface LookupServiceInfo {
  [key: string]: unknown;
}

/** BSV-21 token info extracted from topic managers */
export interface Bsv21TokenInfo {
  tokenId: string;
  symbol?: string;
  icon?: string;
}

/**
 * Client for overlay service routes.
 * Handles topic manager queries and overlay lookups.
 */
export class OverlayClient extends BaseClient {
  constructor(baseUrl: string, options: ClientOptions = {}) {
    super(baseUrl, options);
  }

  /**
   * List all registered topic managers.
   * BSV-21 tokens have topic managers named `tm_{tokenId}`.
   */
  async listTopicManagers(): Promise<Record<string, TopicManagerInfo>> {
    return this.request<Record<string, TopicManagerInfo>>(
      "/1sat/overlay/listTopicManagers",
    );
  }

  /**
   * List all registered lookup service providers.
   */
  async listLookupServiceProviders(): Promise<
    Record<string, LookupServiceInfo>
  > {
    return this.request<Record<string, LookupServiceInfo>>(
      "/1sat/overlay/listLookupServiceProviders",
    );
  }

  /**
   * Get list of active BSV-21 token IDs from topic managers.
   * Extracts tokenIds from topics matching the `tm_{tokenId}` pattern.
   */
  async getActiveBsv21TokenIds(): Promise<string[]> {
    const topicManagers = await this.listTopicManagers();
    const tokenIds: string[] = [];

    for (const topic of Object.keys(topicManagers)) {
      if (topic.startsWith("tm_")) {
        tokenIds.push(topic.slice(3));
      }
    }

    return tokenIds;
  }

  /**
   * Get active BSV-21 tokens with metadata from topic managers.
   * Returns tokenId, symbol (from name), and icon for each active token.
   */
  async getActiveBsv21Tokens(): Promise<Bsv21TokenInfo[]> {
    const topicManagers = await this.listTopicManagers();
    const tokens: Bsv21TokenInfo[] = [];

    for (const [topic, info] of Object.entries(topicManagers)) {
      if (topic.startsWith("tm_")) {
        tokens.push({
          tokenId: topic.slice(3),
          symbol: info.name,
          icon: info.icon,
        });
      }
    }

    return tokens;
  }

  /**
   * Submit a transaction to the overlay service for indexing.
   * @param beef - BEEF data as Uint8Array or number[]
   * @param topics - Topic names to submit to (e.g., ["tm_tokenId"])
   */
  async submit(
    beef: Uint8Array | number[],
    topics: string[],
  ): Promise<{ status: string; txid?: string; message?: string }> {
    const beefArray = beef instanceof Uint8Array ? Array.from(beef) : beef;

    return this.request<{ status: string; txid?: string; message?: string }>(
      "/1sat/overlay/submit",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-Topics": JSON.stringify(topics),
        },
        body: new Blob([new Uint8Array(beefArray)]),
      },
    );
  }

  /**
   * Submit a BSV-21 token transaction to the overlay.
   * Convenience method that formats the topic correctly.
   * @param beef - BEEF data
   * @param tokenId - Token ID (txid_vout format)
   */
  async submitBsv21(
    beef: Uint8Array | number[],
    tokenId: string,
  ): Promise<{ status: string; txid?: string; message?: string }> {
    return this.submit(beef, [`tm_${tokenId}`]);
  }
}
