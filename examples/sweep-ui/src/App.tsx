import { useEffect, useRef, useState } from "react";
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

function parseWif(wif: string): { address: string; error?: string } {
  try {
    const privateKey = PrivateKey.fromWif(wif.trim());
    const address = privateKey.toPublicKey().toAddress();
    return { address };
  } catch (e) {
    return { address: "", error: e instanceof Error ? e.message : "Invalid WIF" };
  }
}

function categorizeUtxos(utxos: IndexedOutput[] | undefined) {
  const ordinals: IndexedOutput[] = [];
  const locks: IndexedOutput[] = [];
  const funds: IndexedOutput[] = [];

  if (!utxos) {
    return { ordinals, locks, funds, fundTotal: 0, lockTotal: 0 };
  }

  for (const utxo of utxos) {
    if (utxo.events?.includes("1sat")) {
      ordinals.push(utxo);
    } else if (utxo.events?.some((e) => e.startsWith("lock"))) {
      locks.push(utxo);
    } else {
      funds.push(utxo);
    }
  }

  const fundTotal = funds.reduce((sum, u) => sum + (u.satoshis ?? 0), 0);
  const lockTotal = locks.reduce((sum, u) => sum + (u.satoshis ?? 0), 0);

  return { ordinals, locks, funds, fundTotal, lockTotal };
}

function isImageType(contentType: string): boolean {
  return contentType.startsWith("image/");
}

function OrdinalCard({ ordinal }: { ordinal: OrdinalWithMetadata }) {
  // Use origin outpoint for content if available (inscriptions live at origin)
  const contentOutpoint = ordinal.metadata?.origin || ordinal.outpoint;
  const contentUrl = services.ordfs.getContentUrl(contentOutpoint);
  const hasContent = ordinal.metadata?.contentType;
  const isImage = hasContent && isImageType(ordinal.metadata!.contentType);

  return (
    <div style={{
      padding: "12px",
      background: "#1a1a1a",
      borderRadius: "8px",
      marginBottom: "8px",
    }}>
      {isImage && (
        <img
          src={contentUrl}
          alt={ordinal.outpoint}
          style={{
            maxWidth: "100%",
            maxHeight: "150px",
            borderRadius: "4px",
            marginBottom: "8px",
          }}
        />
      )}
      <div style={{ fontSize: "10px", wordBreak: "break-all", color: "#888" }}>
        {ordinal.outpoint}
      </div>
      {ordinal.metadata && (
        <div style={{ fontSize: "11px", marginTop: "4px" }}>
          {hasContent ? (
            <>
              <span style={{ color: "#666" }}>Type:</span> {ordinal.metadata.contentType}
              {ordinal.metadata.origin && ordinal.metadata.origin !== ordinal.outpoint && (
                <>
                  <br />
                  <span style={{ color: "#666" }}>Origin:</span> {ordinal.metadata.origin}
                </>
              )}
            </>
          ) : (
            <span style={{ color: "#666", fontStyle: "italic" }}>1sat token (no inscription)</span>
          )}
        </div>
      )}
      {ordinal.metadataError && (
        <div style={{ fontSize: "11px", color: "#f66", marginTop: "4px" }}>
          {ordinal.metadataError}
        </div>
      )}
    </div>
  );
}

function App() {
  const [wif, setWif] = useState("");
  const [destWif, setDestWif] = useState("");
  const [address, setAddress] = useState("");
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [utxos, setUtxos] = useState<IndexedOutput[]>([]);
  const [ordinalsWithMetadata, setOrdinalsWithMetadata] = useState<OrdinalWithMetadata[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Sweep state
  const [sweepAmount, setSweepAmount] = useState("");
  const [sweeping, setSweeping] = useState(false);
  const [sweepResult, setSweepResult] = useState<{ txid?: string; error?: string } | null>(null);

  // Local BRC-100 wallet state
  const [walletStatus, setWalletStatus] = useState<string>("Not initialized");
  const [monitorLogs, setMonitorLogs] = useState<string[]>([]);
  const walletRef = useRef<WebWalletResult | null>(null);


  // Initialize local BRC-100 wallet when destination WIF changes
  useEffect(() => {
    const initWallet = async () => {
      // Cleanup previous wallet
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

        // Wire up monitor callbacks
        result.monitor.onTransactionBroadcasted = async (txResult) => {
          addLog(`📡 BROADCASTED: txid=${txResult.txid}, status=${txResult.status}`);
        };

        result.monitor.onTransactionProven = async (status) => {
          addLog(`✅ PROVEN: txid=${status.txid}`);
        };

        // Start monitor tasks
        addLog("Starting monitor tasks...");
        result.monitor.startTasks().catch((err: unknown) => {
          addLog(`Monitor error: ${err instanceof Error ? err.message : String(err)}`);
        });

        setWalletStatus("Ready");
        addLog("Wallet initialized and monitor running");

        // Log identity key for debugging
        const identityResult = await result.wallet.getPublicKey({ identityKey: true }, window.location.origin);
        addLog(`Identity pubkey: ${identityResult.publicKey}`);
        // Expose wallet for debugging
        (window as unknown as { debugWallet: typeof result }).debugWallet = result;

        // Fetch wallet balance
        const listResult = await result.wallet.listOutputs(
          { basket: FUNDING_BASKET, limit: 10000 },
          window.location.origin
        );
        const satoshis = listResult.outputs.reduce((sum, o) => sum + o.satoshis, 0);
        setWalletBalance(satoshis);
        addLog(`Wallet balance: ${satoshis.toLocaleString()} sats`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        setWalletStatus(`Error: ${msg}`);
        setMonitorLogs((prev) => [...prev, `[ERROR] ${msg}`]);
      }
    };

    initWallet();

    // Cleanup on unmount
    return () => {
      if (walletRef.current) {
        walletRef.current.destroy();
      }
    };
  }, [destWif]);

  const hasWallet = walletRef.current !== null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setUtxos([]);
    setOrdinalsWithMetadata([]);

    const { address: addr, error: parseError } = parseWif(wif);
    if (parseError) {
      setError(parseError);
      return;
    }

    setAddress(addr);
    setLoading(true);

    try {
      const results = await services.owner.getTxos(addr, {
        refresh: true,
        unspent: true,
        sats: true,
        events: true,
        tags: ["*"],
        limit: 100,
      });
      setUtxos(results || []);

      // Fetch metadata for ordinals (seq=0 to get origin metadata)
      const { ordinals } = categorizeUtxos(results || []);
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to fetch UTXOs");
    } finally {
      setLoading(false);
    }
  };

  const { locks, funds, fundTotal, lockTotal } = categorizeUtxos(utxos);

  const handleSweep = async (sweepAll: boolean) => {
    if (!walletRef.current) {
      setSweepResult({ error: "Destination wallet not initialized. Enter destination WIF." });
      return;
    }

    setSweeping(true);
    setSweepResult(null);

    const addLog = (msg: string) => {
      const timestamp = new Date().toISOString().substring(11, 23);
      console.log(`[Sweep] ${msg}`);
      setMonitorLogs((prev) => [...prev, `[${timestamp}] ${msg}`]);
    };

    try {
      const amount = sweepAll ? undefined : Number.parseInt(sweepAmount, 10);

      if (!sweepAll && (!amount || amount <= 0)) {
        setSweepResult({ error: "Invalid amount" });
        setSweeping(false);
        return;
      }

      addLog(`Starting sweep: ${sweepAll ? "ALL" : `${amount} sats`}`);
      addLog(`Source: ${address}`);

      // Create context with local wallet and services
      const ctx = createContext(walletRef.current.wallet, { services, chain: "main" });

      // Prepare sweep inputs (fetches locking scripts from BEEF)
      addLog(`Preparing ${funds.length} UTXOs for sweep...`);
      const sweepInputs = await prepareSweepInputs(ctx, funds);
      addLog(`Prepared ${sweepInputs.length} inputs`);

      // Execute sweep skill
      addLog("Executing sweep...");
      const result = await sweepBsv.execute(ctx, {
        inputs: sweepInputs,
        wif,
        amount,
      });

      if (result.txid) {
        addLog(`✅ Sweep transaction created: ${result.txid}`);
        // Refresh wallet balance after successful sweep
        try {
          const listResult = await walletRef.current!.wallet.listOutputs(
            { basket: FUNDING_BASKET, limit: 10000 },
            window.location.origin
          );
          const satoshis = listResult.outputs.reduce((sum, o) => sum + o.satoshis, 0);
          setWalletBalance(satoshis);
          addLog(`Updated wallet balance: ${satoshis.toLocaleString()} sats`);
        } catch {
          addLog("Could not refresh balance");
        }
      } else if (result.error) {
        addLog(`❌ Sweep failed: ${result.error}`);
      }

      setSweepResult(result);
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Sweep failed";
      addLog(`❌ Error: ${msg}`);
      setSweepResult({ error: msg });
    } finally {
      setSweeping(false);
    }
  };

  return (
    <div className="container">
      <h1>Sweep Tool</h1>

      {/* Source Wallet (Legacy WIF) */}
      <div style={{ marginBottom: "16px", padding: "16px", background: "#1a1a1a", borderRadius: "8px" }}>
        <h3 style={{ margin: "0 0 8px 0" }}>Source Wallet (Legacy WIF)</h3>
        <form onSubmit={handleSubmit}>
          <input
            type="password"
            placeholder="Enter source WIF private key"
            value={wif}
            onChange={(e) => setWif(e.target.value)}
            style={{ width: "100%", padding: "8px", marginBottom: "8px" }}
          />
          <button type="submit" disabled={loading || !wif.trim()}>
            {loading ? "Syncing & Loading..." : "Lookup UTXOs"}
          </button>
        </form>
        {error && <p style={{ color: "red", margin: "8px 0 0 0" }}>{error}</p>}
        {address && <p style={{ margin: "8px 0 0 0" }}>Source Address: <code>{address}</code></p>}
      </div>

      {/* Destination Wallet (BRC-100) */}
      <div style={{ marginBottom: "16px", padding: "16px", background: "#1a1a1a", borderRadius: "8px" }}>
        <h3 style={{ margin: "0 0 8px 0" }}>Destination Wallet (BRC-100)</h3>
        <input
          type="password"
          placeholder="Enter destination WIF private key"
          value={destWif}
          onChange={(e) => setDestWif(e.target.value)}
          style={{ width: "100%", padding: "8px", marginBottom: "8px" }}
        />
        <div style={{ fontSize: "12px", display: "flex", justifyContent: "space-between" }}>
          <span>
            Status: <span style={{ color: walletStatus === "Ready" ? "#4f4" : walletStatus.startsWith("Error") ? "#f66" : "#ff0" }}>{walletStatus}</span>
          </span>
          {walletBalance !== null && (
            <span>Balance: <strong>{walletBalance.toLocaleString()} sats</strong></span>
          )}
        </div>
      </div>

      {utxos.length > 0 && (
        <div style={{ textAlign: "left" }}>
          {funds.length > 0 && (
            <div style={{ marginBottom: "24px", padding: "16px", background: "#1a1a1a", borderRadius: "8px" }}>
              <h2 style={{ margin: "0 0 8px 0" }}>Funds</h2>
              <div style={{ fontSize: "24px", fontWeight: "bold" }}>
                {fundTotal.toLocaleString()} sats
              </div>
              <div style={{ fontSize: "12px", color: "#888", marginBottom: "16px" }}>
                {funds.length} UTXO{funds.length !== 1 ? "s" : ""}
              </div>

              {/* Sweep Controls */}
              <div style={{ borderTop: "1px solid #333", paddingTop: "16px" }}>
                <div style={{ marginBottom: "8px", fontSize: "14px", fontWeight: "bold" }}>
                  Sweep to Destination Wallet
                  {!hasWallet && (
                    <span style={{ color: "#f66", fontWeight: "normal", marginLeft: "8px" }}>
                      (Enter destination WIF above)
                    </span>
                  )}
                </div>
                <div style={{ display: "flex", gap: "8px", alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    type="number"
                    placeholder="Amount (sats)"
                    value={sweepAmount}
                    onChange={(e) => setSweepAmount(e.target.value)}
                    style={{ padding: "8px", width: "150px" }}
                    disabled={sweeping || !hasWallet}
                  />
                  <button
                    type="button"
                    onClick={() => handleSweep(false)}
                    disabled={sweeping || !hasWallet || !sweepAmount}
                    style={{ padding: "8px 16px" }}
                  >
                    {sweeping ? "Sweeping..." : "Sweep Amount"}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSweep(true)}
                    disabled={sweeping || !hasWallet}
                    style={{ padding: "8px 16px" }}
                  >
                    {sweeping ? "Sweeping..." : "Sweep All"}
                  </button>
                </div>
                {sweepResult && (
                  <div style={{ marginTop: "8px", fontSize: "12px" }}>
                    {sweepResult.txid ? (
                      <span style={{ color: "#4f4" }}>
                        Success! TXID: <code>{sweepResult.txid}</code>
                      </span>
                    ) : (
                      <span style={{ color: "#f66" }}>
                        Error: {sweepResult.error}
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {locks.length > 0 && (
            <div style={{ marginBottom: "24px", padding: "16px", background: "#1a1a1a", borderRadius: "8px" }}>
              <h2 style={{ margin: "0 0 8px 0" }}>Locks</h2>
              <div style={{ fontSize: "24px", fontWeight: "bold" }}>
                {lockTotal.toLocaleString()} sats
              </div>
              <div style={{ fontSize: "12px", color: "#888" }}>
                {locks.length} UTXO{locks.length !== 1 ? "s" : ""}
              </div>
            </div>
          )}

          {ordinalsWithMetadata.length > 0 && (
            <div>
              <h2>Ordinals ({ordinalsWithMetadata.length})</h2>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: "8px" }}>
                {ordinalsWithMetadata.map((ordinal) => (
                  <OrdinalCard key={ordinal.outpoint} ordinal={ordinal} />
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {!loading && address && utxos.length === 0 && (
        <p>No UTXOs found for this address</p>
      )}

      {/* Monitor Logs */}
      {monitorLogs.length > 0 && (
        <div style={{ marginTop: "24px", padding: "16px", background: "#0a0a0a", borderRadius: "8px", textAlign: "left" }}>
          <h3 style={{ margin: "0 0 8px 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            Monitor Logs
            <button
              type="button"
              onClick={() => setMonitorLogs([])}
              style={{ padding: "4px 8px", fontSize: "12px" }}
            >
              Clear
            </button>
          </h3>
          <div style={{
            fontFamily: "monospace",
            fontSize: "11px",
            maxHeight: "300px",
            overflowY: "auto",
            background: "#000",
            padding: "8px",
            borderRadius: "4px",
          }}>
            {monitorLogs.map((log, i) => (
              <div key={i} style={{ marginBottom: "2px", whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                {log}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;
