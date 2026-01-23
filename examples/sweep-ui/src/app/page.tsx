"use client";

import { useEffect, useState, useMemo, useCallback } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { WalletInterface } from "@bsv/sdk";
import { PrivateKey } from "@bsv/sdk";
import {
  OneSatServices,
  sweepBsv,
  sweepOrdinals,
  prepareSweepInputs,
  createContext,
  type IndexedOutput,
  type OrdfsMetadata,
  type SweepOrdinalInput,
} from "@1sat/wallet-toolbox";

// Declare window.CWI from yours-wallet extension
declare global {
  interface Window {
    CWI?: WalletInterface;
  }
}
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const services = new OneSatServices("main");

// ============================================================================
// UTILITIES
// ============================================================================

async function fetchBsvPrice(): Promise<number> {
  try {
    const res = await fetch(
      "https://api.whatsonchain.com/v1/bsv/main/exchangerate"
    );
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
  return usd < 0.01 ? "<$0.01" : `$${usd.toFixed(2)}`;
}

function parseWif(
  wif: string
): { address: string; privateKey?: PrivateKey; error?: string } {
  try {
    const privateKey = PrivateKey.fromWif(wif.trim());
    const address = privateKey.toPublicKey().toAddress();
    return { address, privateKey };
  } catch (e) {
    return { address: "", error: e instanceof Error ? e.message : "Invalid WIF" };
  }
}

// ============================================================================
// CONSTANTS & TYPES
// ============================================================================


type DialogState =
  | { type: "idle" }
  | { type: "loading" }
  | { type: "results" }
  | { type: "preview"; sweepType: "fund"; items: IndexedOutput[]; amount?: number }
  | { type: "preview"; sweepType: "ordinals"; items: OrdinalWithMetadata[] };

/**
 * Filter outputs to get only funding UTXOs (P2PKH with satoshis > 1)
 */
function getFundingOutputs(outputs: IndexedOutput[]): IndexedOutput[] {
  return outputs.filter((o) => {
    const sats = o.satoshis ?? 0;
    if (sats <= 1) return false;

    // P2PKH outputs with satoshis > 1 are funding UTXOs
    // Events are in format "p2pkh:address"
    return o.events?.some((e) => e.startsWith("p2pkh:")) ?? false;
  });
}

/**
 * Filter outputs to get ordinal candidates (1-sat outputs excluding locks and bsv-20)
 */
function getOrdinalOutputs(outputs: IndexedOutput[]): IndexedOutput[] {
  return outputs.filter((o) => {
    if (o.satoshis !== 1) return false;
    // Exclude locks
    if (o.events?.some((e) => e.startsWith("lock:"))) return false;
    // Exclude bsv-20 tokens
    if (o.events?.some((e) => e.includes("application/bsv-20"))) return false;
    return true;
  });
}

/**
 * Check if content type is an image
 */
function isImageType(contentType: string): boolean {
  return contentType.startsWith("image/");
}

/**
 * Extract name from OrdfsMetadata map data
 * Name can be in map.name or map.subTypeData.name
 */
function getOrdinalName(metadata?: OrdfsMetadata): string | undefined {
  if (!metadata?.map) return undefined;
  const map = metadata.map;
  if (typeof map.name === "string" && map.name) return map.name;
  if (map.subTypeData && typeof map.subTypeData === "object") {
    const subData = map.subTypeData as Record<string, unknown>;
    if (typeof subData.name === "string" && subData.name) return subData.name;
  }
  return undefined;
}

/** Ordinal output with fetched metadata */
interface OrdinalWithMetadata extends IndexedOutput {
  metadata?: OrdfsMetadata;
  metadataError?: string;
}

const ORDINALS_PER_PAGE = 20;

// ============================================================================
// PRIMITIVE COMPONENTS
// ============================================================================

function Spinner({
  size = 24,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "rounded-full border-2 border-border border-t-current animate-spin",
        className
      )}
      style={{ width: size, height: size }}
      aria-label="Loading"
    />
  );
}

function SectionHeader({
  title,
  variant = "default",
  icon,
}: {
  title: string;
  variant?: "source" | "destination" | "default";
  icon?: React.ReactNode;
}) {
  const colorClass = {
    source: "text-primary",
    destination: "text-accent-foreground",
    default: "text-foreground",
  }[variant];

  const bgClass = {
    source: "bg-primary/10",
    destination: "bg-accent/10",
    default: "bg-accent",
  }[variant];

  return (
    <div className="flex items-center gap-2.5 mb-4">
      {icon ? (
        <div className={cn("w-8 h-8 rounded-lg flex items-center justify-center text-base", bgClass, colorClass)}>
          {icon}
        </div>
      ) : null}
      <h2 className={cn("m-0 text-lg font-semibold tracking-tight", colorClass)}>
        {title}
      </h2>
    </div>
  );
}

function BalanceDisplay({
  sats,
  price,
  label,
  size = "default",
  align = "left",
}: {
  sats: number;
  price: number;
  label?: string;
  size?: "small" | "default" | "large";
  align?: "left" | "right" | "center";
}) {
  const bsv = sats / 100_000_000;
  const usd = price > 0 ? bsv * price : 0;

  const sizeClasses = {
    small: { main: "text-sm", sub: "text-[11px]" },
    default: { main: "text-base", sub: "text-xs" },
    large: { main: "text-[28px]", sub: "text-sm" },
  };

  const alignClass = {
    left: "text-left",
    right: "text-right",
    center: "text-center",
  }[align];

  return (
    <div className={alignClass}>
      {label ? (
        <div className="text-[11px] text-muted-foreground mb-1 uppercase tracking-wider">
          {label}
        </div>
      ) : null}
      <div className={cn(sizeClasses[size].main, "font-bold text-chart-2")}>
        {sats.toLocaleString()} sats
      </div>
      <div className={cn(sizeClasses[size].sub, "text-muted-foreground")}>
        {bsv.toFixed(8)} BSV
        {price > 0 ? (
          <span className="ml-2">${usd.toFixed(2)} USD</span>
        ) : null}
      </div>
    </div>
  );
}

function Panel({
  children,
  variant,
  className,
}: {
  children: React.ReactNode;
  variant?: "source" | "destination" | "default";
  className?: string;
}) {
  const borderClass = variant
    ? {
        source: "border-primary/20",
        destination: "border-accent/20",
        default: "border-border",
      }[variant]
    : "border-border/50";

  return (
    <Card className={cn("p-5 rounded-2xl", borderClass, className)}>
      {children}
    </Card>
  );
}

// ============================================================================
// CUSTOM HOOKS
// ============================================================================

type CWIStatus = "checking" | "not-installed" | "not-authenticated" | "authenticating" | "ready" | "error";

interface CWIWalletState {
  status: CWIStatus;
  wallet: WalletInterface | null;
  logs: string[];
  addLog: (msg: string) => void;
  clearLogs: () => void;
  connect: () => void;
}

function useCWIWallet(): CWIWalletState {
  const [status, setStatus] = useState<CWIStatus>("checking");
  const [wallet, setWallet] = useState<WalletInterface | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  const addLog = useCallback((msg: string) => {
    const timestamp = new Date().toISOString().substring(11, 23);
    setLogs((prev) => [...prev, `[${timestamp}] ${msg}`]);
  }, []);

  const clearLogs = useCallback(() => setLogs([]), []);

  // Check for CWI on mount with retries (extension service worker may not be ready immediately)
  useEffect(() => {
    let cancelled = false;

    const checkCWI = async () => {
      const delays = [200, 500, 1000, 2000];

      for (const delay of delays) {
        if (cancelled) return;
        await new Promise((r) => setTimeout(r, delay));
        if (!window.CWI) continue;

        try {
          const { authenticated } = await window.CWI.isAuthenticated({});
          if (cancelled) return;

          if (authenticated) {
            setWallet(window.CWI);
            setStatus("ready");
            addLog("Yours Wallet connected");
            return;
          }
        } catch {
          // Service worker not ready yet, retry
        }
      }

      if (cancelled) return;

      if (!window.CWI) {
        setStatus("not-installed");
      } else {
        setStatus("not-authenticated");
      }
    };

    checkCWI();
    return () => { cancelled = true; };
  }, [addLog]);

  const connect = useCallback(async () => {
    if (!window.CWI) {
      setStatus("not-installed");
      return;
    }

    setStatus("authenticating");
    addLog("Waiting for authentication...");

    try {
      const { authenticated } = await window.CWI.waitForAuthentication({});
      if (authenticated) {
        setWallet(window.CWI);
        setStatus("ready");
        addLog("Yours Wallet connected");
      } else {
        setStatus("not-authenticated");
        addLog("Authentication declined");
      }
    } catch (err) {
      addLog(`Auth error: ${err instanceof Error ? err.message : String(err)}`);
      setStatus("error");
    }
  }, [addLog]);

  return {
    status,
    wallet,
    logs,
    addLog,
    clearLogs,
    connect,
  };
}

// ============================================================================
// SOURCE COMPONENTS
// ============================================================================

function SourceIdleState() {
  return (
    <Panel className="mt-0.5 rounded-t-none border-t-0">
      <div className="text-center py-10 px-5 text-muted-foreground">
        <div className="text-[32px] mb-3 opacity-30">📦</div>
        <p className="m-0 text-sm">Enter a WIF and scan to see wallet contents</p>
      </div>
    </Panel>
  );
}

function SourceLoadingState({
  fundingOutputs,
  pagesFetched,
  isFetchingNextPage,
}: {
  fundingOutputs: IndexedOutput[];
  pagesFetched: number;
  isFetchingNextPage: boolean;
}) {
  const totalSats = fundingOutputs.reduce((sum, o) => sum + (o.satoshis ?? 0), 0);

  return (
    <Panel className="mt-0.5 rounded-t-none border-t-0">
      <div className="text-center p-6">
        <Spinner size={40} className="text-primary mx-auto" />
        <div className="mt-4 text-base font-medium">Scanning wallet...</div>
        <div className="mt-2 text-[13px] text-muted-foreground">
          {isFetchingNextPage
            ? `Fetching page ${pagesFetched + 1}...`
            : "First request may take a moment"}
        </div>
      </div>

      {fundingOutputs.length > 0 ? (
        <div className="mt-6 p-4 bg-black/20 rounded-xl">
          <div className="text-[11px] text-muted-foreground mb-3 uppercase tracking-wider">
            Discovered
          </div>
          <div className="flex justify-between items-center py-2">
            <span className="font-medium text-[13px] text-chart-2">
              Funding UTXOs
            </span>
            <span className="text-[13px]">
              <span className="text-foreground">{fundingOutputs.length}</span>
              <span className="text-chart-2 ml-2">
                {totalSats.toLocaleString()} sats
              </span>
            </span>
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

function SourcePreviewState({
  dialogState,
  price,
}: {
  dialogState: Extract<DialogState, { type: "preview" }>;
  price: number;
}) {
  const isOrdinals = dialogState.sweepType === "ordinals";
  const totalSats = dialogState.items.reduce((sum, i) => sum + (i.satoshis ?? 0), 0);

  return (
    <Panel className="mt-0.5 rounded-t-none border-t-0">
      <div className="text-center mb-5">
        <h3 className={cn("m-0 mb-2", isOrdinals ? "text-primary" : "text-chart-2")}>
          Confirm Sweep
        </h3>
        <p className="m-0 text-[13px] text-muted-foreground">
          {isOrdinals
            ? `Sweeping ${dialogState.items.length} Ordinal${dialogState.items.length !== 1 ? "s" : ""}`
            : `Sweeping ${dialogState.items.length} Funding UTXO${dialogState.items.length !== 1 ? "s" : ""}`}
        </p>
      </div>
      {isOrdinals ? (
        <div className="text-center text-2xl font-bold text-primary">
          {dialogState.items.length} Ordinal{dialogState.items.length !== 1 ? "s" : ""}
        </div>
      ) : (
        <BalanceDisplay sats={totalSats} price={price} size="large" align="center" />
      )}
    </Panel>
  );
}

// ============================================================================
// ORDINAL COMPONENTS
// ============================================================================

function OrdinalCard({
  ordinal,
  isSelected,
  isSweepable,
  onToggle,
  contentUrl,
}: {
  ordinal: OrdinalWithMetadata;
  isSelected: boolean;
  isSweepable: boolean;
  onToggle: () => void;
  contentUrl: string;
}) {
  const contentType = ordinal.metadata?.contentType ?? "";
  const isImage = isImageType(contentType);
  const isBsv20 = contentType === "application/bsv-20";
  const hasMetadata = !!ordinal.metadata;
  const hasError = !!ordinal.metadataError;
  const name = getOrdinalName(ordinal.metadata);

  const thumbnailUrl = isImage ? contentUrl : null;

  return (
    <div
      className={cn(
        "relative p-3 rounded-xl border transition-all cursor-pointer",
        isSweepable && isSelected
          ? "border-chart-2 bg-chart-2/10"
          : isSweepable
            ? "border-border/50 hover:border-border bg-black/20"
            : "border-border/30 bg-black/10 opacity-60 cursor-not-allowed"
      )}
      onClick={isSweepable ? onToggle : undefined}
    >
      {/* Checkbox */}
      <div className="absolute top-2 right-2">
        <div
          className={cn(
            "w-5 h-5 rounded border-2 flex items-center justify-center",
            isSweepable
              ? isSelected
                ? "bg-chart-2 border-chart-2"
                : "border-muted-foreground/50"
              : "border-muted-foreground/30"
          )}
        >
          {isSelected && isSweepable && (
            <span className="text-black text-xs font-bold">✓</span>
          )}
        </div>
      </div>

      {/* Thumbnail / Icon */}
      <div className="w-full aspect-square mb-2 rounded-lg overflow-hidden bg-black/30 flex items-center justify-center">
        {thumbnailUrl ? (
          <img
            src={thumbnailUrl}
            alt="Ordinal"
            className="w-full h-full object-cover"
            loading="lazy"
          />
        ) : hasError ? (
          <span className="text-destructive text-2xl">⚠</span>
        ) : !hasMetadata ? (
          <Spinner size={20} className="text-muted-foreground" />
        ) : (
          <span className="text-muted-foreground text-2xl">📄</span>
        )}
      </div>

      {/* Badges */}
      <div className="flex flex-wrap gap-1">
        {isBsv20 && (
          <span className="px-1.5 py-0.5 text-[10px] rounded bg-chart-4/20 text-chart-4">
            Token
          </span>
        )}
        {hasError && (
          <span className="px-1.5 py-0.5 text-[10px] rounded bg-destructive/20 text-destructive">
            Error
          </span>
        )}
        {!hasMetadata && !hasError && (
          <span className="px-1.5 py-0.5 text-[10px] rounded bg-muted text-muted-foreground">
            Loading
          </span>
        )}
        {hasMetadata && !isBsv20 && (
          <span className="px-1.5 py-0.5 text-[10px] rounded bg-primary/20 text-primary truncate max-w-full">
            {contentType.split("/")[1] || contentType}
          </span>
        )}
      </div>

      {/* Name or Outpoint */}
      {name ? (
        <div className="mt-1 text-[10px] text-foreground truncate font-medium" title={name}>
          {name}
        </div>
      ) : (
        <div className="mt-1 text-[9px] text-muted-foreground truncate font-mono">
          {ordinal.outpoint.substring(0, 8)}...
        </div>
      )}
    </div>
  );
}

function OrdinalsSection({
  ordinalsWithMetadata,
  sweepableOrdinals,
  selectedOrdinals,
  ordinalPage,
  totalOrdinalPages,
  hasWallet,
  onToggle,
  onSelectAll,
  onDeselectAll,
  onPageChange,
  onSweep,
}: {
  ordinalsWithMetadata: OrdinalWithMetadata[];
  sweepableOrdinals: OrdinalWithMetadata[];
  selectedOrdinals: Set<string>;
  ordinalPage: number;
  totalOrdinalPages: number;
  hasWallet: boolean;
  onToggle: (outpoint: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onPageChange: (page: number) => void;
  onSweep: () => void;
}) {
  const selectedCount = selectedOrdinals.size;
  const sweepableOutpoints = new Set(sweepableOrdinals.map((o) => o.outpoint));

  return (
    <div className="mt-5 p-5 bg-gradient-to-br from-primary/5 to-transparent rounded-xl border border-primary/20">
      <div className="flex justify-between items-start mb-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2 h-2 rounded-full bg-primary" />
            <span className="text-sm font-semibold text-primary">Ordinals</span>
          </div>
          <div className="text-xs text-muted-foreground">
            {ordinalsWithMetadata.length} on this page
            {sweepableOrdinals.length < ordinalsWithMetadata.length && (
              <span> ({sweepableOrdinals.length} sweepable)</span>
            )}
          </div>
        </div>

        {/* Selection controls */}
        <div className="flex gap-2">
          <Button
            type="button"
            onClick={onSelectAll}
            disabled={!hasWallet || sweepableOrdinals.length === 0}
            size="sm"
            variant="outline"
            className="text-[11px] h-7"
          >
            Select All
          </Button>
          <Button
            type="button"
            onClick={onDeselectAll}
            disabled={selectedCount === 0}
            size="sm"
            variant="outline"
            className="text-[11px] h-7"
          >
            Deselect
          </Button>
        </div>
      </div>

      {/* Ordinal Grid */}
      <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 lg:grid-cols-8 gap-2 mb-4">
        {ordinalsWithMetadata.map((ordinal) => (
          <OrdinalCard
            key={ordinal.outpoint}
            ordinal={ordinal}
            isSelected={selectedOrdinals.has(ordinal.outpoint)}
            isSweepable={sweepableOutpoints.has(ordinal.outpoint)}
            onToggle={() => onToggle(ordinal.outpoint)}
            contentUrl={services.ordfs.getContentUrl(ordinal.metadata?.origin ?? ordinal.outpoint)}
          />
        ))}
      </div>

      {/* Pagination */}
      {totalOrdinalPages > 1 && (
        <div className="flex justify-center items-center gap-4 mb-4">
          <Button
            type="button"
            onClick={() => onPageChange(ordinalPage - 1)}
            disabled={ordinalPage === 0}
            size="sm"
            variant="ghost"
            className="text-xs"
          >
            ← Prev
          </Button>
          <span className="text-xs text-muted-foreground">
            Page {ordinalPage + 1} of {totalOrdinalPages}
          </span>
          <Button
            type="button"
            onClick={() => onPageChange(ordinalPage + 1)}
            disabled={ordinalPage >= totalOrdinalPages - 1}
            size="sm"
            variant="ghost"
            className="text-xs"
          >
            Next →
          </Button>
        </div>
      )}

      {/* Sweep button */}
      <Button
        type="button"
        onClick={onSweep}
        disabled={!hasWallet || selectedCount === 0}
        className={cn(
          "w-full gap-2",
          hasWallet && selectedCount > 0 && "bg-primary hover:bg-primary/90"
        )}
      >
        Sweep Selected ({selectedCount}) →
      </Button>

      {!hasWallet && (
        <div className="mt-3 p-2 bg-chart-4/10 rounded-lg text-xs text-chart-4 text-center">
          Connect Yours Wallet to enable sweep
        </div>
      )}
    </div>
  );
}

function SourceResultsState({
  fundingOutputs,
  price,
  hasWallet,
  sweepAmount,
  onAmountChange,
  onSweepFunding,
  isError,
  error,
  sweepResult,
  ordinalsWithMetadata,
  sweepableOrdinals,
  selectedOrdinals,
  ordinalPage,
  totalOrdinalPages,
  totalOrdinalCount,
  onToggleOrdinal,
  onSelectAllOrdinals,
  onDeselectAllOrdinals,
  onOrdinalPageChange,
  onSweepOrdinals,
}: {
  fundingOutputs: IndexedOutput[];
  price: number;
  hasWallet: boolean;
  sweepAmount: string;
  onAmountChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSweepFunding: (all: boolean, amount?: number) => void;
  isError: boolean;
  error: Error | null;
  sweepResult: { txid?: string; error?: string } | null;
  ordinalsWithMetadata: OrdinalWithMetadata[];
  sweepableOrdinals: OrdinalWithMetadata[];
  selectedOrdinals: Set<string>;
  ordinalPage: number;
  totalOrdinalPages: number;
  totalOrdinalCount: number;
  onToggleOrdinal: (outpoint: string) => void;
  onSelectAllOrdinals: () => void;
  onDeselectAllOrdinals: () => void;
  onOrdinalPageChange: (page: number) => void;
  onSweepOrdinals: () => void;
}) {
  const totalSats = fundingOutputs.reduce((sum, o) => sum + (o.satoshis ?? 0), 0);

  return (
    <Panel className="mt-0.5 rounded-t-none border-t-0">
      {isError ? (
        <div className="p-3 px-4 bg-destructive/10 rounded-lg text-destructive text-[13px] mb-4">
          Error: {error instanceof Error ? error.message : "Failed to fetch"}
        </div>
      ) : null}

      {sweepResult ? (
        <div
          className={cn(
            "p-3 px-4 rounded-lg mb-4 text-[13px]",
            sweepResult.txid ? "bg-chart-2/10 text-chart-2" : "bg-destructive/10 text-destructive"
          )}
        >
          {sweepResult.txid ? (
            <span>
              ✓ Sweep successful: <code className="text-[11px]">{sweepResult.txid}</code>
            </span>
          ) : (
            <span>✗ {sweepResult.error}</span>
          )}
        </div>
      ) : null}

      {fundingOutputs.length === 0 && totalOrdinalCount === 0 ? (
        <div className="text-center py-10 px-5">
          <div className="text-[32px] mb-3 opacity-30">∅</div>
          <p className="m-0 text-muted-foreground">No UTXOs found for this address</p>
        </div>
      ) : (
        <>
          {/* Funding UTXOs Section */}
          {fundingOutputs.length > 0 && (
            <div className="p-5 bg-gradient-to-br from-chart-2/5 to-transparent rounded-xl border border-chart-2/20 mb-5">
              <div className="flex justify-between items-start mb-4">
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="w-2 h-2 rounded-full bg-chart-2" />
                    <span className="text-sm font-semibold text-chart-2">
                      Funding UTXOs
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {fundingOutputs.length} output{fundingOutputs.length !== 1 ? "s" : ""}
                  </div>
                </div>
                <BalanceDisplay sats={totalSats} price={price} size="default" align="right" />
              </div>

              <div className="flex gap-2 flex-wrap items-center">
                <Button
                  type="button"
                  onClick={() => onSweepFunding(true)}
                  disabled={!hasWallet}
                  size="sm"
                  className={cn("text-xs", hasWallet && "bg-chart-2 hover:bg-chart-2/90 text-black")}
                >
                  Sweep All →
                </Button>
                <Input
                  type="number"
                  placeholder="Amount (sats)"
                  value={sweepAmount}
                  onChange={onAmountChange}
                  disabled={!hasWallet}
                  className="w-[120px] text-xs bg-black/30"
                />
                <Button
                  type="button"
                  onClick={() => {
                    const amt = Number.parseInt(sweepAmount, 10);
                    if (amt > 0) onSweepFunding(false, amt);
                  }}
                  disabled={!hasWallet || !sweepAmount}
                  size="sm"
                  variant="secondary"
                  className="text-xs"
                >
                  Sweep Amount →
                </Button>
              </div>

              {!hasWallet && (
                <div className="mt-3 p-2 bg-chart-4/10 rounded-lg text-xs text-chart-4 text-center">
                  Connect Yours Wallet to enable sweep
                </div>
              )}
            </div>
          )}

          {/* Ordinals Section */}
          {totalOrdinalCount > 0 && (
            <OrdinalsSection
              ordinalsWithMetadata={ordinalsWithMetadata}
              sweepableOrdinals={sweepableOrdinals}
              selectedOrdinals={selectedOrdinals}
              ordinalPage={ordinalPage}
              totalOrdinalPages={totalOrdinalPages}
              hasWallet={hasWallet}
              onToggle={onToggleOrdinal}
              onSelectAll={onSelectAllOrdinals}
              onDeselectAll={onDeselectAllOrdinals}
              onPageChange={onOrdinalPageChange}
              onSweep={onSweepOrdinals}
            />
          )}
        </>
      )}
    </Panel>
  );
}

function SourceWalletInput({
  wif,
  onWifChange,
  onSubmit,
  isLoading,
  parsedWif,
  address,
}: {
  wif: string;
  onWifChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSubmit: (e: React.FormEvent) => void;
  isLoading: boolean;
  parsedWif: ReturnType<typeof parseWif> | null;
  address: string;
}) {
  const canSubmit = !isLoading && wif.trim() && !parsedWif?.error;

  return (
    <Panel variant="source">
      <SectionHeader title="Source Wallet" variant="source" icon="↑" />
      <p className="text-[13px] text-muted-foreground mb-4">
        Enter the WIF private key of the legacy wallet to sweep from
      </p>
      <form onSubmit={onSubmit} className="space-y-3">
        <Input
          type="password"
          placeholder="WIF private key (starts with K, L, or 5)"
          value={wif}
          onChange={onWifChange}
          className={cn(
            "font-mono bg-black/30",
            parsedWif?.error && "border-destructive focus-visible:ring-destructive"
          )}
        />
        {parsedWif?.error ? (
          <p className="text-destructive text-xs m-0">
            {parsedWif.error}
          </p>
        ) : null}
        <Button
          type="submit"
          disabled={!canSubmit}
          className={cn(
            "w-full gap-2",
            canSubmit && "bg-gradient-to-br from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70"
          )}
        >
          {isLoading ? (
            <>
              <Spinner size={16} className="text-white" />
              Scanning...
            </>
          ) : (
            "Scan Wallet"
          )}
        </Button>
      </form>
      {address ? (
        <div className="mt-4 p-3 bg-black/20 rounded-lg text-xs">
          <span className="text-muted-foreground">Address: </span>
          <code className="text-primary break-all">
            {address}
          </code>
        </div>
      ) : null}
    </Panel>
  );
}

function SourceContentPreview({
  dialogState,
  fundingOutputs,
  pagesFetched,
  isFetchingNextPage,
  price,
  hasWallet,
  sweepAmount,
  setSweepAmount,
  onSweepFunding,
  isError,
  error,
  sweepResult,
  ordinalsWithMetadata,
  sweepableOrdinals,
  selectedOrdinals,
  ordinalPage,
  totalOrdinalPages,
  totalOrdinalCount,
  onToggleOrdinal,
  onSelectAllOrdinals,
  onDeselectAllOrdinals,
  onOrdinalPageChange,
  onSweepOrdinals,
}: {
  dialogState: DialogState;
  fundingOutputs: IndexedOutput[];
  pagesFetched: number;
  isFetchingNextPage: boolean;
  price: number;
  hasWallet: boolean;
  sweepAmount: string;
  setSweepAmount: (v: string) => void;
  onSweepFunding: (all: boolean, amount?: number) => void;
  isError: boolean;
  error: Error | null;
  sweepResult: { txid?: string; error?: string } | null;
  ordinalsWithMetadata: OrdinalWithMetadata[];
  sweepableOrdinals: OrdinalWithMetadata[];
  selectedOrdinals: Set<string>;
  ordinalPage: number;
  totalOrdinalPages: number;
  totalOrdinalCount: number;
  onToggleOrdinal: (outpoint: string) => void;
  onSelectAllOrdinals: () => void;
  onDeselectAllOrdinals: () => void;
  onOrdinalPageChange: (page: number) => void;
  onSweepOrdinals: () => void;
}) {
  const handleAmountChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setSweepAmount(e.target.value),
    [setSweepAmount]
  );

  switch (dialogState.type) {
    case "idle":
      return <SourceIdleState />;
    case "loading":
      return (
        <SourceLoadingState
          fundingOutputs={fundingOutputs}
          pagesFetched={pagesFetched}
          isFetchingNextPage={isFetchingNextPage}
        />
      );
    case "preview":
      return <SourcePreviewState dialogState={dialogState} price={price} />;
    case "results":
      return (
        <SourceResultsState
          fundingOutputs={fundingOutputs}
          price={price}
          hasWallet={hasWallet}
          sweepAmount={sweepAmount}
          onAmountChange={handleAmountChange}
          onSweepFunding={onSweepFunding}
          isError={isError}
          error={error}
          sweepResult={sweepResult}
          ordinalsWithMetadata={ordinalsWithMetadata}
          sweepableOrdinals={sweepableOrdinals}
          selectedOrdinals={selectedOrdinals}
          ordinalPage={ordinalPage}
          totalOrdinalPages={totalOrdinalPages}
          totalOrdinalCount={totalOrdinalCount}
          onToggleOrdinal={onToggleOrdinal}
          onSelectAllOrdinals={onSelectAllOrdinals}
          onDeselectAllOrdinals={onDeselectAllOrdinals}
          onOrdinalPageChange={onOrdinalPageChange}
          onSweepOrdinals={onSweepOrdinals}
        />
      );
  }
}

// ============================================================================
// CWI WALLET COMPONENTS
// ============================================================================

function CWIWalletStatus({
  status,
  logs,
  onConnect,
  onClearLogs,
}: {
  status: CWIStatus;
  logs: string[];
  onConnect: () => void;
  onClearLogs: () => void;
}) {
  const statusDisplay: Record<CWIStatus, { label: string; color: string; bg: string }> = {
    checking: { label: "Checking...", color: "text-chart-4", bg: "bg-chart-4" },
    "not-installed": { label: "Extension Not Found", color: "text-destructive", bg: "bg-destructive" },
    "not-authenticated": { label: "Not Connected", color: "text-chart-4", bg: "bg-chart-4" },
    authenticating: { label: "Connecting...", color: "text-chart-4", bg: "bg-chart-4" },
    ready: { label: "Connected", color: "text-chart-2", bg: "bg-chart-2" },
    error: { label: "Error", color: "text-destructive", bg: "bg-destructive" },
  };

  const { label, color, bg } = statusDisplay[status];

  return (
    <div className="p-4">
      <div className="flex items-center gap-2 mb-4">
        <div className="text-[11px] text-muted-foreground uppercase tracking-wider">
          Yours Wallet
        </div>
        <span className={cn("w-2 h-2 rounded-full shadow-md", bg)} />
        <span className={cn("text-sm font-medium", color)}>{label}</span>
      </div>

      {status === "not-installed" && (
        <div className="p-3 bg-destructive/10 rounded-lg text-sm text-destructive mb-4">
          Please install the{" "}
          <a
            href="https://yours.org"
            target="_blank"
            rel="noopener noreferrer"
            className="underline font-medium"
          >
            Yours Wallet
          </a>{" "}
          Chrome extension to continue.
        </div>
      )}

      {status === "not-authenticated" && (
        <Button onClick={onConnect} className="w-full bg-primary hover:bg-primary/90">
          Connect Wallet
        </Button>
      )}

      {status === "authenticating" && (
        <div className="flex items-center justify-center gap-2 p-3 bg-black/20 rounded-lg">
          <Spinner size={16} className="text-primary" />
          <span className="text-sm text-muted-foreground">
            Waiting for wallet approval...
          </span>
        </div>
      )}

      {logs.length > 0 && (
        <div className="mt-4">
          <div className="flex justify-between items-center mb-2">
            <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
              Activity
            </span>
            <Button
              type="button"
              onClick={onClearLogs}
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-[10px]"
            >
              Clear
            </Button>
          </div>
          <div className="font-mono text-[11px] max-h-[120px] overflow-y-auto bg-black/30 p-2 rounded-lg leading-relaxed">
            {logs.map((log, i) => {
              const isError = log.includes("ERROR") || log.includes("failed") || log.includes("Error");
              const isSuccess = log.includes("Success") || log.includes("connected");
              const colorClass = isError
                ? "text-destructive"
                : isSuccess
                  ? "text-chart-2"
                  : "text-muted-foreground";

              return (
                <div key={i} className={colorClass}>
                  {log}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// SWEEP CONFIRMATION MODAL
// ============================================================================

function BsvSweepConfirmation({
  items,
  amount,
  price,
  onCancel,
  onConfirm,
  sweeping,
}: {
  items: IndexedOutput[];
  amount?: number;
  price: number;
  onCancel: () => void;
  onConfirm: () => void;
  sweeping: boolean;
}) {
  const totalSats = useMemo(
    () => items.reduce((sum, i) => sum + (i.satoshis ?? 0), 0),
    [items]
  );
  const sweepSats = amount ?? totalSats;

  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-[1000] p-5">
      <Card className="w-full max-w-[420px] p-7 bg-gradient-to-br from-card to-black rounded-[20px] border-chart-2/40">
        <h2 className="m-0 mb-2 text-center text-[22px] text-chart-2">
          Confirm Sweep
        </h2>
        <p className="m-0 mb-6 text-center text-sm text-muted-foreground">
          {amount
            ? <>Sweeping <strong className="text-foreground">{amount.toLocaleString()} sats</strong> from {items.length} UTXO{items.length !== 1 ? "s" : ""}</>
            : <>Sweeping <strong className="text-foreground">{items.length}</strong> Funding UTXO{items.length !== 1 ? "s" : ""}</>
          }
        </p>

        <div className="mb-6">
          <BalanceDisplay
            sats={sweepSats}
            price={price}
            size="large"
            align="center"
          />
        </div>

        <div className="flex gap-3">
          <Button
            type="button"
            onClick={onCancel}
            disabled={sweeping}
            variant="outline"
            className="flex-1"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            disabled={sweeping}
            className={cn(
              "flex-1 gap-2",
              !sweeping && "bg-chart-2 hover:bg-chart-2/90 text-black"
            )}
          >
            {sweeping ? (
              <>
                <Spinner size={16} className="text-muted-foreground" />
                Sweeping...
              </>
            ) : (
              "Confirm Sweep"
            )}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function OrdinalSweepConfirmation({
  items,
  services,
  onCancel,
  onConfirm,
  sweeping,
}: {
  items: OrdinalWithMetadata[];
  services: OneSatServices;
  onCancel: () => void;
  onConfirm: () => void;
  sweeping: boolean;
}) {
  return (
    <div className="fixed inset-0 bg-black/80 backdrop-blur-sm flex items-center justify-center z-[1000] p-5">
      <Card className="w-full max-w-[500px] p-7 bg-gradient-to-br from-card to-black rounded-[20px] border-primary/40">
        <h2 className="m-0 mb-2 text-center text-[22px] text-primary">
          Confirm Sweep
        </h2>
        <p className="m-0 mb-4 text-center text-sm text-muted-foreground">
          Sweeping <strong className="text-foreground">{items.length}</strong>{" "}
          Ordinal{items.length !== 1 ? "s" : ""} to your wallet
        </p>

        {/* Ordinal thumbnails grid */}
        <div className="mb-6 max-h-[300px] overflow-y-auto">
          <div className="grid grid-cols-4 gap-2">
            {items.map((ordinal) => {
              const contentType = ordinal.metadata?.contentType ?? "";
              const isImage = isImageType(contentType);
              const contentUrl = services.ordfs.getContentUrl(
                ordinal.metadata?.origin ?? ordinal.outpoint
              );
              const name = getOrdinalName(ordinal.metadata);

              return (
                <div
                  key={ordinal.outpoint}
                  className="rounded-lg overflow-hidden bg-black/30 border border-primary/20"
                >
                  <div className="aspect-square flex items-center justify-center">
                    {isImage ? (
                      <img
                        src={contentUrl}
                        alt={name || "Ordinal"}
                        className="w-full h-full object-cover"
                        loading="lazy"
                      />
                    ) : (
                      <div className="text-center p-1">
                        <span className="text-muted-foreground text-lg">📄</span>
                        <div className="text-[8px] text-muted-foreground truncate">
                          {contentType.split("/")[1] || "file"}
                        </div>
                      </div>
                    )}
                  </div>
                  {name && (
                    <div className="px-1 py-0.5 text-[8px] text-center text-foreground truncate bg-black/40" title={name}>
                      {name}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex gap-3">
          <Button
            type="button"
            onClick={onCancel}
            disabled={sweeping}
            variant="outline"
            className="flex-1"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={onConfirm}
            disabled={sweeping}
            className={cn(
              "flex-1 gap-2",
              !sweeping && "bg-primary hover:bg-primary/90 text-black"
            )}
          >
            {sweeping ? (
              <>
                <Spinner size={16} className="text-muted-foreground" />
                Sweeping...
              </>
            ) : (
              "Confirm Sweep"
            )}
          </Button>
        </div>
      </Card>
    </div>
  );
}

function SweepConfirmationModal({
  dialogState,
  price,
  services,
  onCancel,
  onConfirm,
  sweeping,
}: {
  dialogState: Extract<DialogState, { type: "preview" }>;
  price: number;
  services: OneSatServices;
  onCancel: () => void;
  onConfirm: () => void;
  sweeping: boolean;
}) {
  if (dialogState.sweepType === "ordinals") {
    return (
      <OrdinalSweepConfirmation
        items={dialogState.items as OrdinalWithMetadata[]}
        services={services}
        onCancel={onCancel}
        onConfirm={onConfirm}
        sweeping={sweeping}
      />
    );
  }

  return (
    <BsvSweepConfirmation
      items={dialogState.items}
      amount={dialogState.amount}
      price={price}
      onCancel={onCancel}
      onConfirm={onConfirm}
      sweeping={sweeping}
    />
  );
}

// ============================================================================
// MAIN PAGE
// ============================================================================

export default function SweepPage() {
  // Source state
  const [wif, setWif] = useState("");
  const [address, setAddress] = useState("");
  const [dialogState, setDialogState] = useState<DialogState>({ type: "idle" });

  // CWI wallet state (yours-wallet extension)
  const {
    status: cwiStatus,
    wallet,
    logs: cwiLogs,
    addLog,
    clearLogs,
    connect: connectWallet,
  } = useCWIWallet();
  const hasWallet = cwiStatus === "ready" && wallet !== null;
  const [destExpanded, setDestExpanded] = useState(false);

  // Sweep state
  const [sweepAmount, setSweepAmount] = useState("");
  const [sweeping, setSweeping] = useState(false);
  const [sweepResult, setSweepResult] = useState<{ txid?: string; error?: string } | null>(null);

  // Ordinals state
  const [ordinalsWithMetadata, setOrdinalsWithMetadata] = useState<OrdinalWithMetadata[]>([]);
  const [ordinalPage, setOrdinalPage] = useState(0);
  const [selectedOrdinals, setSelectedOrdinals] = useState<Set<string>>(new Set());

  // BSV Price
  const { data: bsvPrice = 0 } = useQuery({
    queryKey: ["bsv-price"],
    queryFn: fetchBsvPrice,
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  // Parse source WIF
  const parsedWif = useMemo(() => {
    if (!wif.trim()) return null;
    return parseWif(wif);
  }, [wif]);

  // Fetch source outputs
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

  const allOutputs = useMemo(() => data?.pages.flat() ?? [], [data]);
  const fundingOutputs = useMemo(() => getFundingOutputs(allOutputs), [allOutputs]);
  const pagesFetched = data?.pages.length ?? 0;

  // Ordinal computed values
  const ordinalOutputs = useMemo(() => getOrdinalOutputs(allOutputs), [allOutputs]);
  const totalOrdinalPages = Math.ceil(ordinalOutputs.length / ORDINALS_PER_PAGE);

  const currentPageOrdinals = useMemo(() => {
    const start = ordinalPage * ORDINALS_PER_PAGE;
    return ordinalOutputs.slice(start, start + ORDINALS_PER_PAGE);
  }, [ordinalOutputs, ordinalPage]);

  const sweepableOrdinals = useMemo(() => {
    return ordinalsWithMetadata.filter((o) => {
      if (!o.metadata?.contentType) return false;
      if (o.metadata.contentType === "application/bsv-20") return false;
      return true;
    });
  }, [ordinalsWithMetadata]);

  // Transition to results when all pages fetched
  useEffect(() => {
    if (
      dialogState.type === "loading" &&
      !hasNextPage &&
      !isLoading &&
      !isFetchingNextPage &&
      data
    ) {
      setDialogState({ type: "results" });
    }
  }, [dialogState.type, hasNextPage, isLoading, isFetchingNextPage, data]);

  // Fetch metadata for current page of ordinals
  useEffect(() => {
    if (currentPageOrdinals.length === 0 || dialogState.type !== "results") {
      setOrdinalsWithMetadata([]);
      return;
    }

    let cancelled = false;
    setOrdinalsWithMetadata(currentPageOrdinals.map((o) => ({ ...o })));

    Promise.all(
      currentPageOrdinals.map(async (ordinal) => {
        try {
          const metadata = await services.ordfs.getMetadata(ordinal.outpoint, 0);
          return { ...ordinal, metadata };
        } catch (e) {
          return { ...ordinal, metadataError: e instanceof Error ? e.message : "Failed" };
        }
      })
    ).then((results) => {
      if (!cancelled) setOrdinalsWithMetadata(results);
    });

    return () => { cancelled = true; };
  }, [currentPageOrdinals, dialogState.type]);

  // Reset ordinal page and selection when address changes
  useEffect(() => {
    setOrdinalPage(0);
    setSelectedOrdinals(new Set());
  }, [address]);

  // Handlers
  const handleWifChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => setWif(e.target.value),
    []
  );

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      setSweepResult(null);
      if (!parsedWif || parsedWif.error) return;
      setAddress(parsedWif.address);
      setDialogState({ type: "loading" });
    },
    [parsedWif]
  );

  const handleSweepFunding = useCallback(
    (all: boolean, amount?: number) => {
      if (fundingOutputs.length === 0) return;
      setDialogState({
        type: "preview",
        sweepType: "fund",
        items: fundingOutputs,
        amount: all ? undefined : amount,
      });
    },
    [fundingOutputs]
  );

  const handleCancelPreview = useCallback(
    () => setDialogState({ type: "results" }),
    []
  );

  const handleConfirmSweep = useCallback(async () => {
    if (dialogState.type !== "preview" || !wallet) return;

    setSweeping(true);
    setSweepResult(null);

    try {
      const { items, sweepType } = dialogState;
      const ctx = createContext(wallet, {
        services,
        chain: "main",
      });

      if (sweepType === "ordinals") {
        addLog(`Starting ordinal sweep: ${items.length} ordinals`);

        const sweepInputs = await prepareSweepInputs(ctx, items);
        addLog(`Prepared ${sweepInputs.length} inputs`);

        // Build lockingScript lookup, then map items directly
        const scripts = new Map(sweepInputs.map((s) => [s.outpoint, s.lockingScript]));
        const ordinalInputs: SweepOrdinalInput[] = items.map((item) => {
          const ordinal = item as OrdinalWithMetadata;
          return {
            outpoint: item.outpoint,
            satoshis: item.satoshis ?? 1,
            lockingScript: scripts.get(item.outpoint) ?? "",
            contentType: ordinal.metadata?.contentType,
            origin: ordinal.metadata?.origin,
            name: getOrdinalName(ordinal.metadata),
          };
        });

        const result = await sweepOrdinals.execute(ctx, {
          inputs: ordinalInputs,
          wif,
        });

        if (result.txid) {
          addLog(`Success: ${result.txid}`);
          // Clear selection after successful sweep
          setSelectedOrdinals(new Set());
        } else if (result.error) {
          addLog(`Sweep failed: ${result.error}`);
        }

        setSweepResult(result);
      } else {
        const amount = "amount" in dialogState ? dialogState.amount : undefined;
        addLog(`Starting sweep: ${amount ? `${amount} sats` : "ALL"}`);

        const sweepInputs = await prepareSweepInputs(ctx, items);
        addLog(`Prepared ${sweepInputs.length} inputs`);

        const result = await sweepBsv.execute(ctx, {
          inputs: sweepInputs,
          wif,
          amount,
        });

        if (result.txid) {
          addLog(`Success: ${result.txid}`);
        } else if (result.error) {
          addLog(`Sweep failed: ${result.error}`);
        }

        setSweepResult(result);
      }

      setDialogState({ type: "results" });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Sweep failed";
      addLog(`Error: ${msg}`);
      setSweepResult({ error: msg });
      setDialogState({ type: "results" });
    } finally {
      setSweeping(false);
    }
  }, [dialogState, wif, wallet, addLog]);

  // Ordinal selection handlers
  const handleToggleOrdinal = useCallback((outpoint: string) => {
    setSelectedOrdinals((prev) => {
      const next = new Set(prev);
      if (next.has(outpoint)) {
        next.delete(outpoint);
      } else {
        next.add(outpoint);
      }
      return next;
    });
  }, []);

  const handleSelectAllOrdinals = useCallback(() => {
    const sweepableOutpoints = sweepableOrdinals.map((o) => o.outpoint);
    setSelectedOrdinals(new Set(sweepableOutpoints));
  }, [sweepableOrdinals]);

  const handleDeselectAllOrdinals = useCallback(() => {
    setSelectedOrdinals(new Set());
  }, []);

  const handleSweepOrdinals = useCallback(() => {
    const items = ordinalsWithMetadata.filter((o) => selectedOrdinals.has(o.outpoint));
    if (items.length === 0) return;
    setDialogState({
      type: "preview",
      sweepType: "ordinals",
      items,
    });
  }, [ordinalsWithMetadata, selectedOrdinals]);

  return (
    <div className="max-w-[1000px] mx-auto p-6">
      {/* Header */}
      <div className="mb-8 text-center">
        <h1 className="m-0 mb-2 text-[32px] font-bold tracking-tight bg-gradient-to-br from-foreground to-muted-foreground bg-clip-text text-transparent">
          Sweep Tool
        </h1>
        <p className="m-0 text-sm text-muted-foreground">
          Transfer UTXOs from legacy wallets to BRC-100 wallets
        </p>
      </div>

      {/* Source Wallet - Full Width, Prominent */}
      <div className="mb-6">
        <SourceWalletInput
          wif={wif}
          onWifChange={handleWifChange}
          onSubmit={handleSubmit}
          isLoading={dialogState.type === "loading"}
          parsedWif={parsedWif}
          address={address}
        />
        <SourceContentPreview
          dialogState={dialogState}
          fundingOutputs={fundingOutputs}
          pagesFetched={pagesFetched}
          isFetchingNextPage={isFetchingNextPage}
          price={bsvPrice}
          hasWallet={hasWallet}
          sweepAmount={sweepAmount}
          setSweepAmount={setSweepAmount}
          onSweepFunding={handleSweepFunding}
          isError={isError}
          error={error}
          sweepResult={sweepResult}
          ordinalsWithMetadata={ordinalsWithMetadata}
          sweepableOrdinals={sweepableOrdinals}
          selectedOrdinals={selectedOrdinals}
          ordinalPage={ordinalPage}
          totalOrdinalPages={totalOrdinalPages}
          totalOrdinalCount={ordinalOutputs.length}
          onToggleOrdinal={handleToggleOrdinal}
          onSelectAllOrdinals={handleSelectAllOrdinals}
          onDeselectAllOrdinals={handleDeselectAllOrdinals}
          onOrdinalPageChange={setOrdinalPage}
          onSweepOrdinals={handleSweepOrdinals}
        />
      </div>

      {/* Destination Wallet - Collapsible */}
      <Card className="border-accent/20 rounded-2xl overflow-hidden">
        <button
          type="button"
          onClick={() => setDestExpanded(!destExpanded)}
          className="w-full p-4 px-5 bg-card border-0 flex items-center justify-between cursor-pointer text-foreground"
        >
          <div className="flex items-center gap-3">
            <span className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center text-accent-foreground text-base">
              ↓
            </span>
            <div className="text-left">
              <div className="text-base font-semibold text-accent-foreground">
                Destination Wallet
              </div>
              <div className="text-xs text-muted-foreground">
                {cwiStatus === "ready"
                  ? "Connected"
                  : cwiStatus === "not-installed"
                    ? "Extension not found"
                    : cwiStatus === "not-authenticated"
                      ? "Not connected"
                      : cwiStatus === "authenticating"
                        ? "Connecting..."
                        : "Checking..."}
              </div>
            </div>
          </div>
          <span
            className={cn(
              "text-xl text-muted-foreground transition-transform duration-200",
              destExpanded && "rotate-180"
            )}
          >
            ▼
          </span>
        </button>
        {destExpanded && (
          <CWIWalletStatus
            status={cwiStatus}
            logs={cwiLogs}
            onConnect={connectWallet}
            onClearLogs={clearLogs}
          />
        )}
      </Card>

      {/* Sweep Confirmation Modal */}
      {dialogState.type === "preview" && (
        <SweepConfirmationModal
          dialogState={dialogState}
          price={bsvPrice}
          services={services}
          onCancel={handleCancelPreview}
          onConfirm={handleConfirmSweep}
          sweeping={sweeping}
        />
      )}
    </div>
  );
}
