import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { PrivateKey } from "@bsv/sdk";
import {
  OneSatServices,
  sweepBsv,
  prepareSweepInputs,
  createContext,
  createWebWallet,
  FUNDING_BASKET,
  type IndexedOutput,
  type OrdfsMetadata,
  type WebWalletConfig,
  type WebWalletResult,
} from "@1sat/wallet-toolbox";
import "./App.css";

const services = new OneSatServices("main");

// Fetch BSV price in USD
async function fetchBsvPrice(): Promise<number> {
  try {
    const res = await fetch("https://api.whatsonchain.com/v1/bsv/main/exchangerate");
    const data = await res.json();
    return data.rate ?? 0;
  } catch {
    return 0;
  }
}

function formatUsd(sats: number, price: number): string {
  if (price === 0) return "";
  const bsv = sats / 100_000_000;
  const usd = bsv * price;
  return usd < 0.01 ? `<$0.01` : `$${usd.toFixed(2)}`;
}

function formatBsv(sats: number): string {
  const bsv = sats / 100_000_000;
  if (bsv < 0.0001) return `${sats.toLocaleString()} sats`;
  return `${bsv.toFixed(8)} BSV`;
}

// Default permissions for a local test wallet (all disabled)
const TEST_PERMISSIONS_CONFIG = {
  seekProtocolPermissionsForSigning: false,
  seekProtocolPermissionsForEncrypting: false,
  seekProtocolPermissionsForHMAC: false,
  seekPermissionsForKeyLinkageRevelation: false,
  seekPermissionsForPublicKeyRevelation: false,
  seekPermissionsForIdentityKeyRevelation: false,
  seekPermissionsForIdentityResolution: false,
  seekBasketInsertionPermissions: false,
  seekBasketRemovalPermissions: false,
  seekBasketListingPermissions: false,
  seekPermissionWhenApplyingActionLabels: false,
  seekPermissionWhenListingActionsByLabel: false,
  seekCertificateDisclosurePermissions: false,
  seekCertificateAcquisitionPermissions: false,
  seekCertificateRelinquishmentPermissions: false,
  seekCertificateListingPermissions: false,
  encryptWalletMetadata: false,
  seekSpendingPermissions: false,
  seekGroupedPermission: false,
  differentiatePrivilegedOperations: false,
};

interface OrdinalWithMetadata extends IndexedOutput {
  metadata?: OrdfsMetadata;
  metadataError?: string;
}

// Dialog state machine
type DialogState =
  | { type: "idle" }
  | { type: "loading" }
  | { type: "results" }
  | { type: "preview"; sweepType: string; items: IndexedOutput[]; amount?: number };

interface TagTotals {
  count: number;
  sats: number;
  items: IndexedOutput[];
}

// Tag display config - defines how each tag type should be displayed
const TAG_CONFIG: Record<string, { label: string; color: string; sweepable: boolean }> = {
  fund: { label: "Funds", color: "#4ade80", sweepable: true },
  "1sat": { label: "Ordinals (1sat)", color: "#a78bfa", sweepable: true },
  lock: { label: "Locks", color: "#fbbf24", sweepable: false },
  list: { label: "Listed (OrdLock)", color: "#f97316", sweepable: false },
  bsv21: { label: "BSV-21 Tokens", color: "#06b6d4", sweepable: false },
  opns: { label: "OPNS Names", color: "#ec4899", sweepable: false },
};

const TAG_ORDER = ["fund", "1sat", "lock", "list", "bsv21", "opns"];

function parseWif(wif: string): { address: string; privateKey?: PrivateKey; error?: string } {
  try {
    const privateKey = PrivateKey.fromWif(wif.trim());
    const address = privateKey.toPublicKey().toAddress();
    return { address, privateKey };
  } catch (e) {
    return { address: "", error: e instanceof Error ? e.message : "Invalid WIF" };
  }
}

// Compute totals by tag - keeps ALL outputs, doesn't hide anything
function computeTotalsByTag(outputs: IndexedOutput[]): Record<string, TagTotals> {
  const result: Record<string, TagTotals> = {};

  for (const output of outputs) {
    // Use events if available, otherwise default to "fund" for standard UTXOs
    const events = output.events ?? ["fund"];

    // Track output under each of its events
    for (const event of events) {
      // Strip timestamp from lock events (e.g., "lock:1234567890" -> "lock")
      const tag = event.split(":")[0];

      if (!result[tag]) {
        result[tag] = { count: 0, sats: 0, items: [] };
      }

      result[tag].count++;
      result[tag].sats += output.satoshis ?? 0;
      result[tag].items.push(output);
    }
  }

  return result;
}

function isImageType(contentType: string): boolean {
  return contentType.startsWith("image/");
}

// Spinner component
function Spinner({ size = 32 }: { size?: number }) {
  return (
    <div
      style={{
        width: size,
        height: size,
        border: "3px solid rgba(255,255,255,0.1)",
        borderTop: "3px solid #4ade80",
        borderRadius: "50%",
        animation: "spin 1s linear infinite",
      }}
    />
  );
}

// Balance display component
function BalanceDisplay({
  sats,
  price,
  label,
  large = false,
}: {
  sats: number;
  price: number;
  label?: string;
  large?: boolean;
}) {
  const bsv = sats / 100_000_000;
  const usd = price > 0 ? bsv * price : 0;

  return (
    <div>
      {label ? <div style={{ fontSize: "12px", color: "#888", marginBottom: "4px" }}>{label}</div> : null}
      <div style={{ fontSize: large ? "28px" : "16px", fontWeight: "bold", color: "#4ade80" }}>
        {sats.toLocaleString()} sats
      </div>
      <div style={{ fontSize: large ? "14px" : "12px", color: "#888" }}>
        {bsv.toFixed(8)} BSV
        {price > 0 ? <span style={{ marginLeft: "8px" }}>${usd.toFixed(2)} USD</span> : null}
      </div>
    </div>
  );
}

function OrdinalCard({ ordinal }: { ordinal: OrdinalWithMetadata }) {
  const contentOutpoint = ordinal.metadata?.origin ?? ordinal.outpoint;
  const contentUrl = services.ordfs.getContentUrl(contentOutpoint);
  const hasContent = ordinal.metadata?.contentType;
  const isImage = hasContent ? isImageType(ordinal.metadata!.contentType) : false;

  return (
    <div
      style={{
        padding: "12px",
        background: "rgba(255,255,255,0.03)",
        borderRadius: "12px",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      {isImage ? (
        <img
          src={contentUrl}
          alt={ordinal.outpoint}
          style={{
            maxWidth: "100%",
            maxHeight: "150px",
            borderRadius: "8px",
            marginBottom: "8px",
          }}
        />
      ) : null}
      <div style={{ fontSize: "10px", wordBreak: "break-all", color: "#666", fontFamily: "monospace" }}>
        {ordinal.outpoint}
      </div>
      {ordinal.metadata ? (
        <div style={{ fontSize: "11px", marginTop: "4px" }}>
          {hasContent ? (
            <>
              <span style={{ color: "#888" }}>Type:</span>{" "}
              <span style={{ color: "#a78bfa" }}>{ordinal.metadata.contentType}</span>
            </>
          ) : (
            <span style={{ color: "#666", fontStyle: "italic" }}>1sat token (no inscription)</span>
          )}
        </div>
      ) : null}
      {ordinal.metadataError ? (
        <div style={{ fontSize: "11px", color: "#f87171", marginTop: "4px" }}>{ordinal.metadataError}</div>
      ) : null}
      {/* Show all events/tags on the output */}
      {ordinal.events && ordinal.events.length > 0 ? (
        <div style={{ marginTop: "8px", display: "flex", gap: "4px", flexWrap: "wrap" }}>
          {ordinal.events.map((event) => {
            const tag = event.split(":")[0];
            const config = TAG_CONFIG[tag] ?? { label: tag, color: "#888", sweepable: false };
            return (
              <span
                key={event}
                style={{
                  fontSize: "10px",
                  padding: "2px 6px",
                  borderRadius: "4px",
                  background: `${config.color}20`,
                  color: config.color,
                }}
              >
                {event}
              </span>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

// Loading state dialog content
function LoadingDialog({
  totalsByTag,
  pagesFetched,
  isFetchingNextPage,
  price,
}: {
  totalsByTag: Record<string, TagTotals>;
  pagesFetched: number;
  isFetchingNextPage: boolean;
  price: number;
}) {
  // Sort tags: known tags first in order, then unknown tags alphabetically
  const sortedTags = useMemo(() => {
    return Object.keys(totalsByTag).sort((a, b) => {
      const aIdx = TAG_ORDER.indexOf(a);
      const bIdx = TAG_ORDER.indexOf(b);
      if (aIdx === -1 && bIdx === -1) return a.localeCompare(b);
      if (aIdx === -1) return 1;
      if (bIdx === -1) return -1;
      return aIdx - bIdx;
    });
  }, [totalsByTag]);

  const totalSats = useMemo(() => {
    // Sum unique outputs by outpoint to avoid double-counting
    const seen = new Set<string>();
    let total = 0;
    for (const data of Object.values(totalsByTag)) {
      for (const item of data.items) {
        if (!seen.has(item.outpoint)) {
          seen.add(item.outpoint);
          total += item.satoshis ?? 0;
        }
      }
    }
    return total;
  }, [totalsByTag]);

  const hasTotals = Object.keys(totalsByTag).length > 0;

  return (
    <div
      style={{
        padding: "32px",
        background: "linear-gradient(135deg, rgba(30,30,30,0.95) 0%, rgba(20,20,20,0.95) 100%)",
        borderRadius: "16px",
        border: "1px solid rgba(255,255,255,0.1)",
        textAlign: "center",
      }}
    >
      <div style={{ marginBottom: "24px", display: "flex", justifyContent: "center" }}>
        <Spinner size={40} />
      </div>
      <div style={{ fontSize: "18px", fontWeight: "600", marginBottom: "8px" }}>Scanning wallet outputs...</div>
      <div style={{ fontSize: "13px", color: "#888", marginBottom: "24px" }}>
        First request may take a moment while the indexer syncs
      </div>

      {hasTotals ? (
        <div
          style={{
            background: "rgba(0,0,0,0.3)",
            borderRadius: "12px",
            padding: "16px",
            textAlign: "left",
            marginBottom: "16px",
          }}
        >
          <div style={{ fontSize: "12px", color: "#888", marginBottom: "12px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
            Discovered
          </div>
          {sortedTags.map((tag) => {
            const config = TAG_CONFIG[tag] ?? { label: tag, color: "#888", sweepable: false };
            const data = totalsByTag[tag];
            return (
              <div
                key={tag}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "8px 0",
                  borderBottom: "1px solid rgba(255,255,255,0.05)",
                }}
              >
                <span style={{ color: config.color, fontWeight: "500" }}>{config.label}</span>
                <span style={{ textAlign: "right" }}>
                  <span style={{ color: "#fff" }}>{data.count} outputs</span>
                  {data.sats > 0 ? (
                    <span style={{ color: "#4ade80", marginLeft: "12px" }}>
                      {data.sats.toLocaleString()} sats
                      {price > 0 ? (
                        <span style={{ color: "#888", marginLeft: "8px" }}>{formatUsd(data.sats, price)}</span>
                      ) : null}
                    </span>
                  ) : null}
                </span>
              </div>
            );
          })}
          <div style={{ marginTop: "12px", paddingTop: "12px", borderTop: "1px solid rgba(255,255,255,0.1)" }}>
            <BalanceDisplay sats={totalSats} price={price} label="Total Value" />
          </div>
        </div>
      ) : null}

      <div style={{ fontSize: "12px", color: "#666" }}>
        {isFetchingNextPage ? `Fetching page ${pagesFetched + 1}...` : `${pagesFetched} page${pagesFetched !== 1 ? "s" : ""} loaded`}
      </div>
    </div>
  );
}

// Tag section component - shows all outputs for a specific tag
function TagSection({
  tag,
  data,
  price,
  hasWallet,
  onSweep,
}: {
  tag: string;
  data: TagTotals;
  price: number;
  hasWallet: boolean;
  onSweep?: () => void;
}) {
  const config = TAG_CONFIG[tag] ?? { label: tag, color: "#888", sweepable: false };

  return (
    <div
      style={{
        marginBottom: "16px",
        padding: "20px",
        background: "rgba(255,255,255,0.02)",
        borderRadius: "12px",
        border: `1px solid ${config.color}30`,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "12px" }}>
        <div>
          <div style={{ fontSize: "16px", fontWeight: "600", color: config.color, marginBottom: "4px" }}>
            {config.label}
          </div>
          <div style={{ fontSize: "13px", color: "#888" }}>
            {data.count} output{data.count !== 1 ? "s" : ""}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          {data.sats > 0 ? (
            <BalanceDisplay sats={data.sats} price={price} />
          ) : null}
        </div>
      </div>

      {config.sweepable && onSweep ? (
        <button
          type="button"
          onClick={onSweep}
          disabled={!hasWallet}
          style={{
            padding: "10px 20px",
            background: hasWallet ? config.color : "#333",
            color: hasWallet ? "#000" : "#666",
            border: "none",
            borderRadius: "8px",
            fontWeight: "600",
            cursor: hasWallet ? "pointer" : "not-allowed",
            opacity: hasWallet ? 1 : 0.5,
          }}
        >
          Sweep All {config.label}
        </button>
      ) : null}

      {!config.sweepable ? (
        <div style={{ fontSize: "12px", color: "#666", fontStyle: "italic" }}>
          Cannot be swept (locked or listed)
        </div>
      ) : null}
    </div>
  );
}

// Results state dialog content
function ResultsDialog({
  totalsByTag,
  price,
  hasWallet,
  sweepAmount,
  setSweepAmount,
  onSweepTag,
}: {
  totalsByTag: Record<string, TagTotals>;
  price: number;
  hasWallet: boolean;
  sweepAmount: string;
  setSweepAmount: (v: string) => void;
  onSweepTag: (tag: string, all: boolean, amount?: number) => void;
}) {
  const sortedTags = useMemo(() => {
    return Object.keys(totalsByTag).sort((a, b) => {
      const aIdx = TAG_ORDER.indexOf(a);
      const bIdx = TAG_ORDER.indexOf(b);
      if (aIdx === -1 && bIdx === -1) return a.localeCompare(b);
      if (aIdx === -1) return 1;
      if (bIdx === -1) return -1;
      return aIdx - bIdx;
    });
  }, [totalsByTag]);

  // Calculate total unique sats
  const totalSats = useMemo(() => {
    const seen = new Set<string>();
    let total = 0;
    for (const data of Object.values(totalsByTag)) {
      for (const item of data.items) {
        if (!seen.has(item.outpoint)) {
          seen.add(item.outpoint);
          total += item.satoshis ?? 0;
        }
      }
    }
    return total;
  }, [totalsByTag]);

  const handleAmountChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setSweepAmount(e.target.value),
    [setSweepAmount]
  );

  return (
    <div style={{ textAlign: "left" }}>
      {/* Total Balance Header */}
      <div
        style={{
          padding: "24px",
          background: "linear-gradient(135deg, rgba(74,222,128,0.1) 0%, rgba(34,197,94,0.05) 100%)",
          borderRadius: "16px",
          border: "1px solid rgba(74,222,128,0.2)",
          marginBottom: "24px",
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: "12px", color: "#888", marginBottom: "8px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Total Wallet Value
        </div>
        <BalanceDisplay sats={totalSats} price={price} large />
      </div>

      {/* Funds section with amount input */}
      {totalsByTag.fund ? (
        <div
          style={{
            marginBottom: "16px",
            padding: "20px",
            background: "rgba(255,255,255,0.02)",
            borderRadius: "12px",
            border: "1px solid rgba(74,222,128,0.3)",
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "16px" }}>
            <div>
              <div style={{ fontSize: "16px", fontWeight: "600", color: "#4ade80", marginBottom: "4px" }}>Funds</div>
              <div style={{ fontSize: "13px", color: "#888" }}>{totalsByTag.fund.count} outputs</div>
            </div>
            <BalanceDisplay sats={totalsByTag.fund.sats} price={price} />
          </div>

          <div style={{ display: "flex", gap: "8px", flexWrap: "wrap", alignItems: "center" }}>
            <button
              type="button"
              onClick={() => onSweepTag("fund", true)}
              disabled={!hasWallet}
              style={{
                padding: "10px 20px",
                background: hasWallet ? "#4ade80" : "#333",
                color: hasWallet ? "#000" : "#666",
                border: "none",
                borderRadius: "8px",
                fontWeight: "600",
                cursor: hasWallet ? "pointer" : "not-allowed",
              }}
            >
              Sweep All
            </button>
            <input
              type="number"
              placeholder="Amount (sats)"
              value={sweepAmount}
              onChange={handleAmountChange}
              disabled={!hasWallet}
              style={{
                padding: "10px 12px",
                width: "140px",
                background: "rgba(0,0,0,0.3)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: "8px",
                color: "#fff",
              }}
            />
            <button
              type="button"
              onClick={() => {
                const amt = Number.parseInt(sweepAmount, 10);
                if (amt > 0) onSweepTag("fund", false, amt);
              }}
              disabled={!hasWallet || !sweepAmount}
              style={{
                padding: "10px 20px",
                background: hasWallet && sweepAmount ? "#333" : "#222",
                color: hasWallet && sweepAmount ? "#fff" : "#666",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: "8px",
                fontWeight: "500",
                cursor: hasWallet && sweepAmount ? "pointer" : "not-allowed",
              }}
            >
              Sweep Amount
            </button>
          </div>
          {!hasWallet ? (
            <div style={{ fontSize: "12px", color: "#f87171", marginTop: "12px" }}>
              Enter destination WIF to enable sweep
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Other tag sections */}
      {sortedTags
        .filter((tag) => tag !== "fund")
        .map((tag) => (
          <TagSection
            key={tag}
            tag={tag}
            data={totalsByTag[tag]}
            price={price}
            hasWallet={hasWallet}
            onSweep={
              TAG_CONFIG[tag]?.sweepable
                ? () => onSweepTag(tag, true)
                : undefined
            }
          />
        ))}
    </div>
  );
}

// Preview state dialog content
function PreviewDialog({
  sweepType,
  items,
  amount,
  price,
  onCancel,
  onConfirm,
  sweeping,
}: {
  sweepType: string;
  items: IndexedOutput[];
  amount?: number;
  price: number;
  onCancel: () => void;
  onConfirm: () => void;
  sweeping: boolean;
}) {
  const config = TAG_CONFIG[sweepType] ?? { label: sweepType, color: "#888", sweepable: true };

  const { totalSats, txCount, estFees, netAmount } = useMemo(() => {
    const total = items.reduce((sum, i) => sum + (i.satoshis ?? 0), 0);
    const count = Math.ceil(items.length / 100);
    const estFeePerTx = 500;
    const fees = count * estFeePerTx;
    const net = amount ? Math.min(amount, total - fees) : total - fees;
    return { totalSats: total, txCount: count, estFees: fees, netAmount: net };
  }, [items, amount]);

  return (
    <div
      style={{
        padding: "32px",
        background: "linear-gradient(135deg, rgba(30,30,30,0.95) 0%, rgba(20,20,20,0.95) 100%)",
        borderRadius: "16px",
        border: `1px solid ${config.color}40`,
      }}
    >
      <h2 style={{ margin: "0 0 24px 0", textAlign: "center", color: config.color }}>Confirm Sweep</h2>

      <div style={{ marginBottom: "24px", textAlign: "center" }}>
        <div style={{ fontSize: "14px", color: "#888", marginBottom: "8px" }}>
          Sweeping <strong style={{ color: "#fff" }}>{items.length}</strong> {config.label} outputs
        </div>
        <BalanceDisplay sats={totalSats} price={price} large />
      </div>

      <div
        style={{
          background: "rgba(0,0,0,0.3)",
          borderRadius: "12px",
          padding: "16px",
          marginBottom: "24px",
        }}
      >
        <div style={{ fontSize: "12px", color: "#888", marginBottom: "12px", textTransform: "uppercase", letterSpacing: "0.05em" }}>
          Transaction Plan
        </div>
        <ul style={{ margin: "0", padding: "0 0 0 20px", fontSize: "14px", lineHeight: "1.8" }}>
          <li>
            <span style={{ color: "#888" }}>Transactions:</span>{" "}
            <span style={{ color: "#fff" }}>{txCount} (max 100 inputs each)</span>
          </li>
          <li>
            <span style={{ color: "#888" }}>Est. fees:</span>{" "}
            <span style={{ color: "#fbbf24" }}>~{estFees.toLocaleString()} sats</span>
          </li>
          <li>
            <span style={{ color: "#888" }}>Net to wallet:</span>{" "}
            <span style={{ color: "#4ade80" }}>~{netAmount.toLocaleString()} sats</span>
            {price > 0 ? <span style={{ color: "#888" }}> ({formatUsd(netAmount, price)})</span> : null}
          </li>
        </ul>
      </div>

      <div style={{ display: "flex", gap: "12px", justifyContent: "center" }}>
        <button
          type="button"
          onClick={onCancel}
          disabled={sweeping}
          style={{
            padding: "12px 32px",
            background: "#333",
            color: "#fff",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: "8px",
            fontWeight: "500",
            cursor: sweeping ? "not-allowed" : "pointer",
          }}
        >
          Cancel
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={sweeping}
          style={{
            padding: "12px 32px",
            background: sweeping ? "#333" : config.color,
            color: sweeping ? "#888" : "#000",
            border: "none",
            borderRadius: "8px",
            fontWeight: "600",
            cursor: sweeping ? "not-allowed" : "pointer",
            display: "flex",
            alignItems: "center",
            gap: "8px",
          }}
        >
          {sweeping ? (
            <>
              <Spinner size={16} /> Sweeping...
            </>
          ) : (
            "Confirm Sweep"
          )}
        </button>
      </div>
    </div>
  );
}

function App() {
  const [wif, setWif] = useState("");
  const [destWif, setDestWif] = useState("");
  const [address, setAddress] = useState("");
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [ordinalsWithMetadata, setOrdinalsWithMetadata] = useState<OrdinalWithMetadata[]>([]);

  // Dialog state
  const [dialogState, setDialogState] = useState<DialogState>({ type: "idle" });

  // Sweep state
  const [sweepAmount, setSweepAmount] = useState("");
  const [sweeping, setSweeping] = useState(false);
  const [sweepResult, setSweepResult] = useState<{ txid?: string; error?: string } | null>(null);

  // Local BRC-100 wallet state
  const [walletStatus, setWalletStatus] = useState<string>("Not initialized");
  const [monitorLogs, setMonitorLogs] = useState<string[]>([]);
  const walletRef = useRef<WebWalletResult | null>(null);

  // Fetch BSV price
  const { data: bsvPrice = 0 } = useQuery({
    queryKey: ["bsv-price"],
    queryFn: fetchBsvPrice,
    staleTime: 60_000, // 1 minute
    refetchInterval: 60_000,
  });

  // Parse WIF when entered
  const parsedWif = useMemo(() => {
    if (!wif.trim()) return null;
    return parseWif(wif);
  }, [wif]);

  // Infinite query for fetching all outputs
  const {
    data,
    fetchNextPage,
    hasNextPage,
    isFetchingNextPage,
    isLoading,
    isError,
    error,
  } = useInfiniteQuery({
    queryKey: ["txos", address],
    queryFn: async ({ pageParam }: { pageParam: number | undefined }) => {
      const results = await services.owner.getTxos(address, {
        refresh: pageParam === undefined,
        unspent: true,
        sats: true,
        events: true,
        tags: ["*"],
        limit: 100,
        from: pageParam,
      });
      return results ?? [];
    },
    getNextPageParam: (lastPage: IndexedOutput[]) => {
      if (lastPage.length < 100) return undefined;
      return lastPage[lastPage.length - 1].score;
    },
    initialPageParam: undefined as number | undefined,
    enabled: !!address && dialogState.type !== "idle",
  });

  // Auto-fetch all pages
  useEffect(() => {
    if (hasNextPage && !isFetchingNextPage) {
      fetchNextPage();
    }
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  // Flatten all outputs from pages
  const allOutputs = useMemo(() => data?.pages.flat() ?? [], [data]);

  // Compute totals by tag - keeps ALL outputs visible
  const totalsByTag = useMemo(() => computeTotalsByTag(allOutputs), [allOutputs]);

  // Track ordinals count for effect dependency
  const ordinalsCount = totalsByTag["1sat"]?.count ?? 0;

  // Transition to results when all pages fetched
  useEffect(() => {
    if (dialogState.type === "loading" && !hasNextPage && !isLoading && !isFetchingNextPage && allOutputs.length > 0) {
      setDialogState({ type: "results" });

      // Fetch metadata for ordinals
      const fetchOrdinalMetadata = async () => {
        const ordinals = totalsByTag["1sat"]?.items ?? [];
        const withMetadata: OrdinalWithMetadata[] = await Promise.all(
          ordinals.map(async (ordinal) => {
            try {
              const metadata = await services.ordfs.getMetadata(ordinal.outpoint, 0);
              return { ...ordinal, metadata };
            } catch (e) {
              return {
                ...ordinal,
                metadataError: e instanceof Error ? e.message : "Failed to load",
              };
            }
          })
        );
        setOrdinalsWithMetadata(withMetadata);
      };
      fetchOrdinalMetadata();
    }
  }, [dialogState.type, hasNextPage, isLoading, isFetchingNextPage, allOutputs.length, ordinalsCount, totalsByTag]);

  // Transition to results if no outputs found
  useEffect(() => {
    if (dialogState.type === "loading" && !hasNextPage && !isLoading && !isFetchingNextPage && allOutputs.length === 0 && data) {
      setDialogState({ type: "results" });
    }
  }, [dialogState.type, hasNextPage, isLoading, isFetchingNextPage, allOutputs.length, data]);

  // Initialize local BRC-100 wallet when destination WIF changes
  useEffect(() => {
    const initWallet = async () => {
      if (walletRef.current) {
        console.log("[App] Destroying previous wallet...");
        await walletRef.current.destroy();
        walletRef.current = null;
      }

      if (!destWif.trim()) {
        setWalletStatus("Not initialized");
        setWalletBalance(null);
        return;
      }

      try {
        setWalletStatus("Initializing...");
        setMonitorLogs([]);

        const addLog = (msg: string) => {
          const timestamp = new Date().toISOString().substring(11, 23);
          console.log(`[Monitor] ${msg}`);
          setMonitorLogs((prev) => [...prev, `[${timestamp}] ${msg}`]);
        };

        const config: WebWalletConfig = {
          privateKey: destWif.trim(),
          chain: "main",
          adminOriginator: window.location.origin,
          permissionsConfig: TEST_PERMISSIONS_CONFIG,
          remoteStorageUrl: services.storageUrl,
        };

        addLog("Creating wallet...");
        const result = await createWebWallet(config);
        walletRef.current = result;

        result.monitor.onTransactionBroadcasted = async (txResult: { txid: string; status: string }) => {
          addLog(`BROADCASTED: txid=${txResult.txid}, status=${txResult.status}`);
        };

        result.monitor.onTransactionProven = async (status: { txid: string }) => {
          addLog(`PROVEN: txid=${status.txid}`);
        };

        addLog("Starting monitor tasks...");
        result.monitor.startTasks().catch((err: unknown) => {
          addLog(`Monitor error: ${err instanceof Error ? err.message : String(err)}`);
        });

        setWalletStatus("Ready");
        addLog("Wallet initialized and monitor running");

        const identityResult = await result.wallet.getPublicKey({ identityKey: true }, window.location.origin);
        addLog(`Identity pubkey: ${identityResult.publicKey}`);
        (window as unknown as { debugWallet: typeof result }).debugWallet = result;

        const listResult = await result.wallet.listOutputs(
          { basket: FUNDING_BASKET, limit: 10000 },
          window.location.origin
        );
        const satoshis = listResult.outputs.reduce((sum: number, o: { satoshis: number }) => sum + o.satoshis, 0);
        setWalletBalance(satoshis);
        addLog(`Wallet balance: ${satoshis.toLocaleString()} sats`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        setWalletStatus(`Error: ${msg}`);
        setMonitorLogs((prev) => [...prev, `[ERROR] ${msg}`]);
      }
    };

    initWallet();

    return () => {
      if (walletRef.current) {
        walletRef.current.destroy();
      }
    };
  }, [destWif]);

  const hasWallet = walletRef.current !== null;

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      setSweepResult(null);

      if (!parsedWif || parsedWif.error) {
        return;
      }

      setAddress(parsedWif.address);
      setDialogState({ type: "loading" });
      setOrdinalsWithMetadata([]);
    },
    [parsedWif]
  );

  const handleSweepTag = useCallback(
    (tag: string, all: boolean, amount?: number) => {
      const items = totalsByTag[tag]?.items ?? [];
      if (items.length === 0) return;

      setDialogState({
        type: "preview",
        sweepType: tag,
        items,
        amount: all ? undefined : amount,
      });
    },
    [totalsByTag]
  );

  const handleConfirmSweep = useCallback(async () => {
    if (dialogState.type !== "preview" || !walletRef.current) return;

    setSweeping(true);
    setSweepResult(null);

    const addLog = (msg: string) => {
      const timestamp = new Date().toISOString().substring(11, 23);
      console.log(`[Sweep] ${msg}`);
      setMonitorLogs((prev) => [...prev, `[${timestamp}] ${msg}`]);
    };

    try {
      const { items, amount } = dialogState;

      addLog(`Starting sweep: ${amount ? `${amount} sats` : "ALL"}`);
      addLog(`Source: ${address}`);

      const ctx = createContext(walletRef.current.wallet, { services, chain: "main" });

      addLog(`Preparing ${items.length} UTXOs for sweep...`);
      const sweepInputs = await prepareSweepInputs(ctx, items);
      addLog(`Prepared ${sweepInputs.length} inputs`);

      addLog("Executing sweep...");
      const result = await sweepBsv.execute(ctx, {
        inputs: sweepInputs,
        wif,
        amount,
      });

      if (result.txid) {
        addLog(`Sweep transaction created: ${result.txid}`);
        try {
          const listResult = await walletRef.current!.wallet.listOutputs(
            { basket: FUNDING_BASKET, limit: 10000 },
            window.location.origin
          );
          const satoshis = listResult.outputs.reduce((sum: number, o: { satoshis: number }) => sum + o.satoshis, 0);
          setWalletBalance(satoshis);
          addLog(`Updated wallet balance: ${satoshis.toLocaleString()} sats`);
        } catch {
          addLog("Could not refresh balance");
        }
      } else if (result.error) {
        addLog(`Sweep failed: ${result.error}`);
      }

      setSweepResult(result);
      setDialogState({ type: "results" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Sweep failed";
      addLog(`Error: ${msg}`);
      setSweepResult({ error: msg });
    } finally {
      setSweeping(false);
    }
  }, [dialogState, address, wif]);

  const handleCancelPreview = useCallback(() => {
    setDialogState({ type: "results" });
  }, []);

  const handleClearLogs = useCallback(() => {
    setMonitorLogs([]);
  }, []);

  const handleWifChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setWif(e.target.value);
  }, []);

  const handleDestWifChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setDestWif(e.target.value);
  }, []);

  const pagesFetched = data?.pages.length ?? 0;
  const isLoadingState = dialogState.type === "loading";
  const isResultsState = dialogState.type === "results";
  const isPreviewState = dialogState.type === "preview";
  const hasNoOutputs = allOutputs.length === 0;
  const hasLogs = monitorLogs.length > 0;

  return (
    <div className="container">
      <h1 style={{ fontSize: "32px", fontWeight: "700", letterSpacing: "-0.02em", marginBottom: "32px" }}>
        Sweep Tool
      </h1>

      {/* Source Wallet */}
      <div
        style={{
          marginBottom: "16px",
          padding: "20px",
          background: "rgba(255,255,255,0.02)",
          borderRadius: "12px",
          border: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <h3 style={{ margin: "0 0 12px 0", fontSize: "14px", fontWeight: "600", color: "#888" }}>
          Source Wallet (Legacy WIF)
        </h3>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            placeholder="Enter source WIF private key"
            value={wif}
            onChange={handleWifChange}
            style={{
              width: "100%",
              padding: "12px",
              marginBottom: "12px",
              background: "rgba(0,0,0,0.3)",
              border: "1px solid rgba(255,255,255,0.1)",
              borderRadius: "8px",
              color: "#fff",
              fontSize: "14px",
            }}
          />
          <button
            type="submit"
            disabled={isLoadingState || !wif.trim() || !!parsedWif?.error}
            style={{
              width: "100%",
              padding: "12px",
              background: isLoadingState || !wif.trim() || !!parsedWif?.error ? "#333" : "#4ade80",
              color: isLoadingState || !wif.trim() || !!parsedWif?.error ? "#666" : "#000",
              border: "none",
              borderRadius: "8px",
              fontWeight: "600",
              cursor: isLoadingState || !wif.trim() || !!parsedWif?.error ? "not-allowed" : "pointer",
            }}
          >
            {isLoadingState ? "Scanning..." : "Scan Wallet"}
          </button>
        </form>
        {parsedWif?.error ? (
          <p style={{ color: "#f87171", margin: "12px 0 0 0", fontSize: "13px" }}>{parsedWif.error}</p>
        ) : null}
        {address ? (
          <p style={{ margin: "12px 0 0 0", fontSize: "13px", color: "#888" }}>
            Address: <code style={{ color: "#4ade80" }}>{address}</code>
          </p>
        ) : null}
      </div>

      {/* Destination Wallet */}
      <div
        style={{
          marginBottom: "24px",
          padding: "20px",
          background: "rgba(255,255,255,0.02)",
          borderRadius: "12px",
          border: "1px solid rgba(255,255,255,0.08)",
        }}
      >
        <h3 style={{ margin: "0 0 12px 0", fontSize: "14px", fontWeight: "600", color: "#888" }}>
          Destination Wallet (BRC-100)
        </h3>
        <input
          type="password"
          placeholder="Enter destination WIF private key"
          value={destWif}
          onChange={handleDestWifChange}
          style={{
            width: "100%",
            padding: "12px",
            marginBottom: "12px",
            background: "rgba(0,0,0,0.3)",
            border: "1px solid rgba(255,255,255,0.1)",
            borderRadius: "8px",
            color: "#fff",
            fontSize: "14px",
          }}
        />
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: "13px" }}>
          <span>
            Status:{" "}
            <span
              style={{
                color: walletStatus === "Ready" ? "#4ade80" : walletStatus.startsWith("Error") ? "#f87171" : "#fbbf24",
                fontWeight: "500",
              }}
            >
              {walletStatus}
            </span>
          </span>
          {walletBalance !== null ? (
            <BalanceDisplay sats={walletBalance} price={bsvPrice} />
          ) : null}
        </div>
      </div>

      {/* Dialog States */}
      {isLoadingState ? (
        <LoadingDialog
          totalsByTag={totalsByTag}
          pagesFetched={pagesFetched}
          isFetchingNextPage={isFetchingNextPage}
          price={bsvPrice}
        />
      ) : null}

      {isResultsState ? (
        <>
          {isError ? (
            <div
              style={{
                color: "#f87171",
                marginBottom: "16px",
                padding: "12px",
                background: "rgba(248,113,113,0.1)",
                borderRadius: "8px",
              }}
            >
              Error: {error instanceof Error ? error.message : "Failed to fetch"}
            </div>
          ) : null}

          {hasNoOutputs ? (
            <div
              style={{
                textAlign: "center",
                padding: "48px",
                background: "rgba(255,255,255,0.02)",
                borderRadius: "12px",
              }}
            >
              <p style={{ color: "#888", fontSize: "16px" }}>No UTXOs found for this address</p>
            </div>
          ) : (
            <>
              <ResultsDialog
                totalsByTag={totalsByTag}
                price={bsvPrice}
                hasWallet={hasWallet}
                sweepAmount={sweepAmount}
                setSweepAmount={setSweepAmount}
                onSweepTag={handleSweepTag}
              />

              {sweepResult ? (
                <div
                  style={{
                    marginTop: "16px",
                    padding: "16px",
                    background: sweepResult.txid ? "rgba(74,222,128,0.1)" : "rgba(248,113,113,0.1)",
                    borderRadius: "12px",
                    border: `1px solid ${sweepResult.txid ? "rgba(74,222,128,0.3)" : "rgba(248,113,113,0.3)"}`,
                  }}
                >
                  {sweepResult.txid ? (
                    <span style={{ color: "#4ade80" }}>
                      Success! TXID: <code style={{ fontSize: "12px" }}>{sweepResult.txid}</code>
                    </span>
                  ) : (
                    <span style={{ color: "#f87171" }}>Error: {sweepResult.error}</span>
                  )}
                </div>
              ) : null}

              {/* Ordinal Cards */}
              {ordinalsWithMetadata.length > 0 ? (
                <div style={{ marginTop: "32px" }}>
                  <h2 style={{ fontSize: "18px", fontWeight: "600", marginBottom: "16px", color: "#a78bfa" }}>
                    Ordinals ({ordinalsWithMetadata.length})
                  </h2>
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
                      gap: "12px",
                    }}
                  >
                    {ordinalsWithMetadata.map((ordinal) => (
                      <OrdinalCard key={ordinal.outpoint} ordinal={ordinal} />
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </>
      ) : null}

      {isPreviewState ? (
        <PreviewDialog
          sweepType={dialogState.sweepType}
          items={dialogState.items}
          amount={dialogState.amount}
          price={bsvPrice}
          onCancel={handleCancelPreview}
          onConfirm={handleConfirmSweep}
          sweeping={sweeping}
        />
      ) : null}

      {/* Monitor Logs */}
      {hasLogs ? (
        <div
          style={{
            marginTop: "32px",
            padding: "20px",
            background: "rgba(0,0,0,0.3)",
            borderRadius: "12px",
            border: "1px solid rgba(255,255,255,0.05)",
          }}
        >
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: "12px",
            }}
          >
            <h3 style={{ margin: 0, fontSize: "14px", fontWeight: "600", color: "#888" }}>Monitor Logs</h3>
            <button
              type="button"
              onClick={handleClearLogs}
              style={{
                padding: "4px 12px",
                fontSize: "12px",
                background: "rgba(255,255,255,0.05)",
                border: "1px solid rgba(255,255,255,0.1)",
                borderRadius: "4px",
                color: "#888",
                cursor: "pointer",
              }}
            >
              Clear
            </button>
          </div>
          <div
            style={{
              fontFamily: "monospace",
              fontSize: "11px",
              maxHeight: "200px",
              overflowY: "auto",
              background: "rgba(0,0,0,0.5)",
              padding: "12px",
              borderRadius: "8px",
              lineHeight: "1.6",
            }}
          >
            {monitorLogs.map((log, i) => (
              <div key={i} style={{ color: log.includes("ERROR") ? "#f87171" : "#888" }}>
                {log}
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
