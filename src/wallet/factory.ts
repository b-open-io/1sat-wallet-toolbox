/**
 * Factory for creating web wallets.
 *
 * This consolidates the common wallet setup used by both yours-wallet
 * (browser extension) and 1sat-website (React app).
 */

import { KeyDeriver, PrivateKey, type WalletInterface } from "@bsv/sdk";
import {
	Wallet,
	WalletStorageManager,
	StorageProvider,
	StorageIdb,
	StorageClient,
	WalletPermissionsManager,
	Services,
	Monitor,
	type PermissionsManagerConfig,
	type sdk as mobileToolboxSdk,
} from "@bsv/wallet-toolbox-mobile/out/src/index.client.js";
import { type sdk as toolboxSdk } from "@bsv/wallet-toolbox";
import { OneSatServices } from "../services/OneSatServices";

type Chain = "main" | "test";
type WalletServices = toolboxSdk.WalletServices;
type MobileWalletServices = mobileToolboxSdk.WalletServices;

// Default database name for IndexedDB storage
const DEFAULT_DATABASE_NAME = "wallet";

// Default timeout for remote storage connection
const DEFAULT_REMOTE_STORAGE_TIMEOUT = 5000;

// Default fee model (100 sat/kb matches yours-wallet and 1sat-indexer minimum)
const DEFAULT_FEE_MODEL = { model: "sat/kb" as const, value: 100 };

/**
 * Configuration for creating a web wallet.
 */
export interface WebWalletConfig {
	/** Private key - can be PrivateKey instance, WIF string, or hex string */
	privateKey: PrivateKey | string;
	/** Network: 'main' or 'test' */
	chain: Chain;
	/** Admin originator that bypasses permission checks (e.g., chrome-extension://id or https://wallet.example.com) */
	adminOriginator: string;
	/** Permission configuration for WalletPermissionsManager */
	permissionsConfig: PermissionsManagerConfig;
	/** Fee model. Default: { model: 'sat/kb', value: 1 } */
	feeModel?: { model: "sat/kb"; value: number };
	/** Remote storage URL. If provided, attempts to connect for cloud backup. */
	remoteStorageUrl?: string;
}

/**
 * Result of wallet creation.
 */
export interface WebWalletResult {
	/** Wallet instance with permission management */
	wallet: WalletPermissionsManager;
	/** 1Sat services for API access */
	services: OneSatServices;
	/** Monitor for transaction lifecycle (not started - call monitor.startTasks() when ready) */
	monitor: Monitor;
	/** Cleanup function - stops monitor, destroys wallet */
	destroy: () => Promise<void>;
}

/**
 * Parse a private key from various input formats.
 * Supports PrivateKey instance, WIF string, or hex string.
 */
function parsePrivateKey(input: PrivateKey | string): PrivateKey {
	if (input instanceof PrivateKey) {
		return input;
	}

	// Try WIF first (starts with 5, K, L for mainnet or c for testnet)
	if (/^[5KLc][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(input)) {
		return PrivateKey.fromWif(input);
	}

	// Try hex (64 characters)
	if (/^[0-9a-fA-F]{64}$/.test(input)) {
		return new PrivateKey(input);
	}

	// Last resort - try WIF anyway
	try {
		return PrivateKey.fromWif(input);
	} catch {
		throw new Error(
			"Invalid private key format. Expected PrivateKey instance, WIF string, or 64-char hex string.",
		);
	}
}

/**
 * Create a web wallet with storage, services, permissions, and monitor.
 *
 * @example
 * ```typescript
 * const { wallet, services, monitor, destroy } = await createWebWallet({
 *   privateKey: identityWif,
 *   chain: 'main',
 *   adminOriginator: 'https://wallet.example.com',
 *   permissionsConfig: DEFAULT_PERMISSIONS_CONFIG,
 * });
 *
 * // Wire up monitor callbacks
 * monitor.onTransactionProven = async (status) => console.log('Proven:', status.txid);
 *
 * // Start monitor when ready
 * monitor.startTasks();
 * ```
 */
export async function createWebWallet(
	config: WebWalletConfig,
): Promise<WebWalletResult> {
	const { chain, adminOriginator, permissionsConfig } = config;
	const feeModel = config.feeModel ?? DEFAULT_FEE_MODEL;

	// 1. Parse private key and create KeyDeriver
	const privateKey = parsePrivateKey(config.privateKey);
	const identityPubKey = privateKey.toPublicKey().toString();
	const keyDeriver = new KeyDeriver(privateKey);

	// 2. Create fallback services and OneSatServices
	const fallbackServices = new Services(chain);
	const oneSatServices = new OneSatServices(
		chain,
		undefined,
		fallbackServices as unknown as WalletServices,
	);

	// 3. Create local storage
	const storageOptions = StorageProvider.createStorageBaseOptions(chain);
	storageOptions.feeModel = feeModel;
	const localStorage = new StorageIdb(storageOptions);
	await localStorage.migrate(DEFAULT_DATABASE_NAME, identityPubKey);

	// 4. Create storage manager (local-only initially)
	let storage = new WalletStorageManager(identityPubKey, localStorage);
	await storage.makeAvailable();

	// 5. Create the underlying Wallet
	const underlyingWallet = new Wallet({
		chain,
		keyDeriver,
		storage,
		services: oneSatServices as unknown as MobileWalletServices,
	});

	// 6. Attempt remote storage connection if URL provided
	if (config.remoteStorageUrl) {
		console.log(`[createWebWallet] Attempting remote storage connection to ${config.remoteStorageUrl}`);
		try {
			const remoteClient = new StorageClient(
				underlyingWallet as unknown as WalletInterface,
				config.remoteStorageUrl,
			);
			const timeoutPromise = new Promise<never>((_, reject) =>
				setTimeout(
					() => reject(new Error("Remote storage connection timeout")),
					DEFAULT_REMOTE_STORAGE_TIMEOUT,
				),
			);
			await Promise.race([remoteClient.makeAvailable(), timeoutPromise]);

			// Remote connected - recreate storage manager with backup
			storage = new WalletStorageManager(identityPubKey, localStorage, [
				remoteClient,
			]);
			await storage.makeAvailable();

			// Check for conflicting actives and resolve if needed
			const storageAny = storage as unknown as {
				_active?: { settings?: { storageIdentityKey?: string } };
				_backups?: Array<{ settings?: { storageIdentityKey?: string } }>;
				_conflictingActives?: Array<{ settings?: { storageIdentityKey?: string } }>;
				setActive?: (storageIdentityKey: string, log?: (msg: string) => string) => Promise<void>;
				updateBackups?: (activeSync?: unknown, log?: (msg: string) => string) => Promise<string>;
			};
			console.log("[createWebWallet] Storage state:", {
				activeKey: storageAny._active?.settings?.storageIdentityKey,
				backups: storageAny._backups?.map(b => b.settings?.storageIdentityKey),
				conflictingActives: storageAny._conflictingActives?.map(c => c.settings?.storageIdentityKey),
			});

			// Treat backups as conflicts to pull any data they have.
			// Remote storage may have transactions that local doesn't know about
			// (e.g., from sweep-ui syncing to remote).
			if (storageAny._backups && storageAny._backups.length > 0) {
				console.log("[createWebWallet] Reclassifying backups as conflicts to pull remote data...");
				storageAny._conflictingActives = storageAny._conflictingActives || [];
				storageAny._conflictingActives.push(...storageAny._backups);
				storageAny._backups = [];
			}

			// If there are conflicting actives (including reclassified backups), resolve by merging into local
			// This is now blocking since setActive no longer holds IDB transactions during network calls
			if (storageAny._conflictingActives && storageAny._conflictingActives.length > 0) {
				const localKey = storageAny._active?.settings?.storageIdentityKey;
				if (localKey && storageAny.setActive) {
					console.log("[createWebWallet] Syncing with remote storage...");
					try {
						await storageAny.setActive(localKey, (msg: string) => {
							console.log("[createWebWallet] Sync:", msg);
							return msg;
						});
						console.log("[createWebWallet] Remote sync complete");
					} catch (err: unknown) {
						console.log("[createWebWallet] Remote sync failed:", err instanceof Error ? err.message : err);
					}
				}
			}

			// Update wallet's storage reference
			(
				underlyingWallet as unknown as { _storage: WalletStorageManager }
			)._storage = storage;
			console.log("[createWebWallet] Remote storage connected successfully");
		} catch (err) {
			console.log("[createWebWallet] Remote storage connection failed:", err instanceof Error ? err.message : err);
			// Graceful degradation - continue with local only
		}
	}

	// 7. Wrap with permissions manager
	const wallet = new WalletPermissionsManager(
		underlyingWallet,
		adminOriginator,
		permissionsConfig,
	);

	// 8. Create monitor (not started - consumer calls startTasks() when ready)
	const monitor = new Monitor({
		chain,
		services: oneSatServices as unknown as typeof fallbackServices,
		storage,
		chaintracks: oneSatServices.chaintracks,
		msecsWaitPerMerkleProofServiceReq: 500,
		taskRunWaitMsecs: 5000,
		abandonedMsecs: 300000,
		unprovenAttemptsLimitTest: 10,
		unprovenAttemptsLimitMain: 144,
	});
	monitor.addDefaultTasks();

	// 9. Create cleanup function
	const destroy = async (): Promise<void> => {
		monitor.stopTasks();
		await monitor.destroy();
		await underlyingWallet.destroy();
	};

	return {
		wallet,
		services: oneSatServices,
		monitor,
		destroy,
	};
}
