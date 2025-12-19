import type {
  BalanceResponse,
  ClientOptions,
  IndexedOutput,
  SyncOutput,
  TxoQueryOptions,
} from "../types";
import { BaseClient } from "./BaseClient";

/**
 * Client for /api/owner/* routes.
 * Provides owner (address) queries and sync.
 *
 * Routes:
 * - GET /:owner/txos - Get TXOs for owner
 * - GET /:owner/balance - Get balance
 * - GET /:owner/sync - SSE stream of outputs for sync
 */
export class OwnerClient extends BaseClient {
  constructor(baseUrl: string, options: ClientOptions = {}) {
    super(`${baseUrl}/api/owner`, options);
  }

  /**
   * Get TXOs owned by an address/owner
   */
  async getTxos(
    owner: string,
    opts?: TxoQueryOptions & { refresh?: boolean },
  ): Promise<IndexedOutput[]> {
    const qs = this.buildQueryString({
      tags: opts?.tags,
      from: opts?.from,
      limit: opts?.limit,
      rev: opts?.rev,
      unspent: opts?.unspent,
      refresh: opts?.refresh,
    });
    return this.request<IndexedOutput[]>(`/${owner}/txos${qs}`);
  }

  /**
   * Get balance for an address/owner
   */
  async getBalance(owner: string): Promise<BalanceResponse> {
    return this.request<BalanceResponse>(`/${owner}/balance`);
  }

  /**
   * Sync outputs for an owner via SSE stream.
   * Returns an EventSource that emits SyncOutput events.
   *
   * @param owner - Address/owner to sync
   * @param onOutput - Callback for each output
   * @param from - Starting score (for pagination/resumption)
   * @param onDone - Callback when sync completes (client should retry after delay)
   * @param onError - Callback for errors
   * @returns Unsubscribe function
   */
  sync(
    owner: string,
    onOutput: (output: SyncOutput) => void,
    from?: number,
    onDone?: () => void,
    onError?: (error: Error) => void,
  ): () => void {
    const url = `${this.baseUrl}/${owner}/sync?from=${from ?? 0}`;
    const eventSource = new EventSource(url);

    eventSource.onmessage = (event) => {
      try {
        const output = JSON.parse(event.data) as SyncOutput;
        onOutput(output);
      } catch (e) {
        onError?.(e instanceof Error ? e : new Error(String(e)));
      }
    };

    eventSource.addEventListener("done", () => {
      eventSource.close();
      onDone?.();
    });

    eventSource.onerror = () => {
      eventSource.close();
      onError?.(new Error("SSE connection error"));
    };

    return () => {
      eventSource.close();
    };
  }

  /**
   * Sync outputs as an async iterator.
   * Yields SyncOutput objects until the stream is done.
   */
  async *syncIterator(
    owner: string,
    from?: number,
  ): AsyncGenerator<SyncOutput, void, unknown> {
    const outputs: SyncOutput[] = [];
    let done = false;
    let error: Error | null = null;
    let resolve: (() => void) | null = null;

    const unsubscribe = this.sync(
      owner,
      (output) => {
        outputs.push(output);
        resolve?.();
      },
      from,
      () => {
        done = true;
        resolve?.();
      },
      (e) => {
        error = e;
        resolve?.();
      },
    );

    try {
      while (!done && !error) {
        if (outputs.length > 0) {
          const output = outputs.shift();
          if (output) yield output;
        } else {
          await new Promise<void>((r) => {
            resolve = r;
          });
        }
      }

      // Yield remaining outputs
      while (outputs.length > 0) {
        const output = outputs.shift();
        if (output) yield output;
      }

      if (error) {
        throw error;
      }
    } finally {
      unsubscribe();
    }
  }
}
