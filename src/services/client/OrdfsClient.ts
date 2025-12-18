import type { ClientOptions, OrdfsMetadata } from "../types";
import { BaseClient } from "./BaseClient";

/**
 * Client for /api/ordfs/* routes.
 * Provides inscription content and metadata.
 *
 * Routes:
 * - GET /metadata/:outpoint - Get inscription metadata
 * - GET /output/:outpoint - Get inscription content
 * - GET /preview/:b64HtmlData - Preview HTML content
 * - POST /preview - Preview HTML content (body)
 */
export class OrdfsClient extends BaseClient {
  constructor(baseUrl: string, options: ClientOptions = {}) {
    super(baseUrl, options);
  }

  /**
   * Get metadata for an inscription
   */
  async getMetadata(outpoint: string): Promise<OrdfsMetadata> {
    return this.request<OrdfsMetadata>(`/metadata/${outpoint}`);
  }

  /**
   * Get inscription content as binary
   */
  async getContent(outpoint: string): Promise<Uint8Array> {
    return this.requestBinary(`/output/${outpoint}`);
  }

  /**
   * Get inscription content with content-type header
   */
  async getContentWithType(
    outpoint: string,
  ): Promise<{ data: Uint8Array; contentType: string }> {
    const response = await this.requestRaw(`/output/${outpoint}`);
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
    return `${this.baseUrl}/output/${outpoint}`;
  }
}
