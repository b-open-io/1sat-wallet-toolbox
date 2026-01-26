import { BaseClient } from "./BaseClient";
import type { ClientOptions } from "../types";

/** Topic manager metadata returned by listTopicManagers */
export interface TopicManagerInfo {
  [key: string]: unknown;
}

/** Lookup service provider metadata returned by listLookupServiceProviders */
export interface LookupServiceInfo {
  [key: string]: unknown;
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
      "/overlay/listTopicManagers"
    );
  }

  /**
   * List all registered lookup service providers.
   */
  async listLookupServiceProviders(): Promise<Record<string, LookupServiceInfo>> {
    return this.request<Record<string, LookupServiceInfo>>(
      "/overlay/listLookupServiceProviders"
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
}
