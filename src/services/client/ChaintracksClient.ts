import type { ChainTracker } from "@bsv/sdk";
import type { BlockHeader, ClientOptions } from "../types";
import { BaseClient } from "./BaseClient";

/**
 * Helper to read a 32-bit unsigned integer from little-endian bytes
 */
function readUint32LE(data: Uint8Array, offset: number): number {
  return (
    (data[offset] |
      (data[offset + 1] << 8) |
      (data[offset + 2] << 16) |
      (data[offset + 3] << 24)) >>>
    0
  );
}

/**
 * Convert bytes to hex string (little-endian)
 */
function toHexLE(data: Uint8Array): string {
  return Array.from(data)
    .reverse()
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * SHA256 hash
 */
async function sha256(data: Uint8Array): Promise<Uint8Array> {
  const buf = await crypto.subtle.digest(
    "SHA-256",
    data as unknown as ArrayBuffer,
  );
  return new Uint8Array(buf);
}

/**
 * Double SHA256 hash (used for block header hash)
 */
async function doubleSha256(data: Uint8Array): Promise<Uint8Array> {
  return sha256(await sha256(data));
}

/**
 * Parse raw 80-byte header into BlockHeader object
 */
async function parseHeader(
  data: Uint8Array,
  height: number,
): Promise<BlockHeader> {
  const version = readUint32LE(data, 0);
  const prevHash = toHexLE(data.slice(4, 36));
  const merkleRoot = toHexLE(data.slice(36, 68));
  const time = readUint32LE(data, 68);
  const bits = readUint32LE(data, 72);
  const nonce = readUint32LE(data, 76);
  const hash = toHexLE(await doubleSha256(data));

  return { height, hash, version, prevHash, merkleRoot, time, bits, nonce };
}

/**
 * Client for /api/chaintracks/* routes.
 * Provides block header data and implements ChainTracker interface.
 *
 * Routes:
 * - GET /tip - Get chain tip
 * - GET /tip/stream - SSE stream of new blocks
 * - GET /height - Get current height
 * - GET /network - Get network type
 * - GET /headers?height=N&count=M - Get raw header bytes
 * - GET /header/height/:height - Get header by height
 * - GET /header/hash/:hash - Get header by hash
 */
export class ChaintracksClient extends BaseClient implements ChainTracker {
  private eventSource: EventSource | null = null;
  private subscribers: Set<(header: BlockHeader) => void> = new Set();

  constructor(baseUrl: string, options: ClientOptions = {}) {
    super(`${baseUrl}/api/chaintracks`, options);
  }

  /**
   * Get current blockchain height (ChainTracker interface)
   */
  async currentHeight(): Promise<number> {
    const tip = await this.getTip();
    return tip.height;
  }

  /**
   * Validate merkle root for a given height (ChainTracker interface)
   */
  async isValidRootForHeight(root: string, height: number): Promise<boolean> {
    try {
      const header = await this.getHeaderByHeight(height);
      const isValid = header.merkleRoot === root;
      console.log(
        `isValidRootForHeight(${height}): expected=${root}, got=${header.merkleRoot}, valid=${isValid}`,
      );
      return isValid;
    } catch (e) {
      console.error(`isValidRootForHeight(${height}) failed:`, e);
      return false;
    }
  }

  /**
   * Get the network type (main or test)
   */
  async getNetwork(): Promise<string> {
    const data = await this.request<{ network: string }>("/network");
    return data.network;
  }

  /**
   * Get the current chain tip
   */
  async getTip(): Promise<BlockHeader> {
    return this.request<BlockHeader>("/tip");
  }

  /**
   * Get block header by height
   */
  async getHeaderByHeight(height: number): Promise<BlockHeader> {
    return this.request<BlockHeader>(`/header/height/${height}`);
  }

  /**
   * Get block header by hash
   */
  async getHeaderByHash(hash: string): Promise<BlockHeader> {
    return this.request<BlockHeader>(`/header/hash/${hash}`);
  }

  /**
   * Get multiple headers as parsed BlockHeader objects
   */
  async getHeaders(height: number, count: number): Promise<BlockHeader[]> {
    const data = await this.requestBinary(
      `/headers?height=${height}&count=${count}`,
    );

    if (data.length % 80 !== 0) {
      throw new Error(`Invalid response length: ${data.length} bytes`);
    }

    const headers: BlockHeader[] = [];
    for (let i = 0; i < data.length; i += 80) {
      headers.push(await parseHeader(data.slice(i, i + 80), height + i / 80));
    }

    return headers;
  }

  /**
   * Get raw header bytes for one or more headers
   */
  async getHeaderBytes(height: number, count = 1): Promise<number[]> {
    const data = await this.requestBinary(
      `/headers?height=${height}&count=${count}`,
    );
    return Array.from(data);
  }

  /**
   * Subscribe to new block notifications via SSE
   * Returns unsubscribe function
   */
  subscribe(callback: (header: BlockHeader) => void): () => void {
    this.subscribers.add(callback);

    if (!this.eventSource) {
      this.eventSource = new EventSource(`${this.baseUrl}/tip/stream`);
      this.eventSource.onmessage = (event) => {
        try {
          const header = JSON.parse(event.data) as BlockHeader;
          for (const cb of this.subscribers) {
            cb(header);
          }
        } catch {
          // Ignore parse errors (e.g., keepalive messages)
        }
      };
      this.eventSource.onerror = () => {
        this.eventSource?.close();
        this.eventSource = null;
      };
    }

    return () => {
      this.subscribers.delete(callback);
      if (this.subscribers.size === 0 && this.eventSource) {
        this.eventSource.close();
        this.eventSource = null;
      }
    };
  }

  /**
   * Close all connections
   */
  close(): void {
    if (this.eventSource) {
      this.eventSource.close();
      this.eventSource = null;
    }
    this.subscribers.clear();
  }
}
