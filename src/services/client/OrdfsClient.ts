import type { ClientOptions, OrdfsMetadata } from "../types";
import { BaseClient } from "./BaseClient";

/**
 * Client for ordfs routes.
 * Provides inscription content and metadata.
 *
 * Content is served from baseUrl directly (e.g., https://api.1sat.app/:outpoint)
 * API routes use /api/ordfs (e.g., https://api.1sat.app/api/ordfs/metadata/:outpoint)
 */
export class OrdfsClient extends BaseClient {
  constructor(baseUrl: string, options: ClientOptions = {}) {
    super(`${baseUrl}/api/ordfs`, options);
  }

  /**
   * Get metadata for an inscription
   */
  async getMetadata(outpoint: string): Promise<OrdfsMetadata> {
    return this.request<OrdfsMetadata>(`/metadata/${outpoint}`);
  }

  /**
   * Get inscription content as binary (fetches from content URL)
   */
  async getContent(outpoint: string): Promise<Uint8Array> {
    const response = await fetch(this.getContentUrl(outpoint));
    if (!response.ok) {
      throw new Error(`Failed to fetch content: ${response.statusText}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    return new Uint8Array(arrayBuffer);
  }

  /**
   * Get inscription content with content-type header
   */
  async getContentWithType(
    outpoint: string,
  ): Promise<{ data: Uint8Array; contentType: string }> {
    const response = await fetch(this.getContentUrl(outpoint));
    if (!response.ok) {
      throw new Error(`Failed to fetch content: ${response.statusText}`);
    }
    const contentType =
      response.headers.get("content-type") || "application/octet-stream";
    const arrayBuffer = await response.arrayBuffer();
    return {
      data: new Uint8Array(arrayBuffer),
      contentType,
    };
  }

  /**
   * Get the URL for fetching inscription content directly
   * Useful for displaying in img/video tags
   */
  getContentUrl(outpoint: string): string {
    // Content served from base URL without /api
    const contentBaseUrl = this.baseUrl.replace("/api/ordfs", "");
    return `${contentBaseUrl}/${outpoint}`;
  }
}
