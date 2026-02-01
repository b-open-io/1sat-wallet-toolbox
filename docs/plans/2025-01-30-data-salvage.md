# Data Salvage Plan

## Problem Statement

Wallet databases are corrupted from multiple fullSync operations. Need to recover spendable outputs and transfer them to the sweep address.

**Sweep Address:** `1DPbfnhdKsZwaYXZ96eARHKtb3ZUjeLdLf`

## Data Sources

| Source | Location | Access Method | Status |
|--------|----------|---------------|--------|
| sweep-ui IndexedDB | Browser | Chrome console queries | Available |
| Remote SQLite | `rack:/home/shruggr/.1sat/wallet.sqlite` | `scp` | Available |
| yours-wallet backup | File system export | yours-wallet UI | Broken |

**Important:** Read-only access until we understand the problem. No writes to any database.

## Known Corruption (from ORDINAL_TRANSFER_DEBUG.md)

- 106 total outputs in 1sat basket (remote)
- 90 marked spendable
- 51 have NULL tx_id (orphan records)
- ALL outputs have base64 customInstructions instead of expected JSON

**Expected customInstructions format:**
```json
{"protocolID":[1,"onesat"],"keyID":"<input_outpoint>"}
```

## Recovery Strategy

*Pending findings from fullsync-diagnosis.md*

### Phase 1: Inventory

1. [ ] Query all outputs from sweep-ui IDB
2. [ ] Query all outputs from remote SQLite
3. [ ] Compare records - identify which source has better data
4. [ ] For each output, check if transaction exists on-chain
5. [ ] For each on-chain output, check if spent

### Phase 2: Reconstruct customInstructions

For ordinals that exist on-chain and are unspent:
1. Fetch transaction from chain
2. Find corresponding input (input[n] → output[n] mapping)
3. Calculate correct customInstructions: `{"protocolID":[1,"onesat"],"keyID":"<input_outpoint>"}`
4. Verify by deriving address and comparing to on-chain address

### Phase 3: Transfer to Sweep Address

For each recoverable ordinal:
1. Verify we can derive the correct signing key
2. Build transfer transaction
3. Broadcast and verify

## Existing Tools

- `examples/sweep-ui/src/components/DebugPanel.tsx` - Diagnostic UI with:
  - "Investigate Ordinals" - Lists ordinals
  - "Diagnose Selected" - Checks customInstructions validity
  - "Repair Repairable" - Updates IDB (DO NOT USE until diagnosis complete)

## Dependencies

This plan depends on findings from `2025-01-30-fullsync-diagnosis.md` to:
- Understand how data got corrupted
- Determine which data source is most trustworthy
- Know if repair is safe or if we need alternative recovery

## Next Steps

1. [ ] Complete fullsync diagnosis (see other plan)
2. [ ] Inventory both data sources
3. [ ] Determine recovery approach based on diagnosis findings
