# Ordinal Transfer Debugging - Investigation Log

## The Problem

Transfers fail when trying to move ordinals OUT of the BRC-100 wallet.

**Observed:**
- Transfer attempt fails with error: "undefined is not iterable"
- `customInstructions` from `listOutputs` is a base64-looking string, not JSON
- `transferOrdinals` expects JSON: `{ protocolID, keyID }`

## Key Discovery: customInstructions is NOT Encrypted

**Investigation confirmed:** `customInstructions` is stored and retrieved as plain text throughout the entire stack:
- `wallet-toolbox/src/storage/methods/createAction.ts#L393` - stores as plain string
- `wallet-toolbox/src/storage/methods/listOutputsIdb.ts#L179` - returns as-is
- `go-wallet-toolbox/pkg/storage/internal/sync/chunk_processor.go#L378` - passes through directly

The base64-looking string is **genuinely wrong data**, not encrypted data that needs decryption.

**Expected format:**
```json
{"protocolID":[1,"onesat"],"keyID":"<input_outpoint>"}
```

**Actual (corrupted):**
```
z1GeK+6bj9lsiRUhVaOmO787LWilygbW3qqrvMqALdkIPI4FG+wc...
```

## Potential Corruption Sources

1. **sweepOrdinals never wrote correct data** - bug in original sweep logic
2. **fullSync merged wrong record's customInstructions** - data from different output got applied
3. **Data overwritten by subsequent operation** - some other action corrupted it

## Server Database Analysis (2026-01-30)

**Connection:** `ssh rack` → `/home/shruggr/.1sat/wallet.sqlite`

### Findings

**1sat basket statistics:**
- 106 total outputs
- 90 marked spendable
- **51 have NULL tx_id (orphan records)**

**Orphan outputs cause:**
- Reference transactions with `status = 'failed'` and empty `tx_id`
- Failed transactions didn't clean up their associated outputs
- Example: transaction_id 4, 7, 8 all show status='failed', tx_id=''

**customInstructions corruption:**
- ALL outputs have base64-looking strings instead of JSON
- Expected: `{"protocolID":[1,"onesat"],"keyID":"<outpoint>"}`
- Actual: `SumeFO/Ok7aIpL//k1aj82neTW2bRWswzB6aGbJlaXQ3wVcngNIolyHh9jve...`

**Stale output example (`62c4cd26...2`):**
- On-chain address: `1JmHZ2xUmBzjSQ3V5cp9u9ZdmrQyGG9dkE`
- Derived address: `183GPqwaFL3PR5Uv45PNYYz2ceSJao5LkK`
- **MISMATCH** - this output doesn't belong to this wallet or has been transferred

**Current ordinal location (`db09c125...0`):**
- 1 sat, spendable=1
- **NO basket assignment** (should be '1sat')
- **NO customInstructions** (cannot be transferred)

## Recovery Plan

### Phase 1: Diagnose & Repair (Current)

1. **Build diagnostic tool** to:
   - Show current (corrupted) customInstructions for each ordinal
   - Look up transaction on-chain to find inputs
   - Calculate what customInstructions SHOULD be (input[n] → output[n] mapping)
   - Derive expected address from protocolID/keyID
   - Compare to on-chain address
   - Report if repairable

2. **Repair the data** - Update customInstructions with correct values

3. **Transfer ordinals back** to sweep address: `1DPbfnhdKsZwaYXZ96eARHKtb3ZUjeLdLf`

### Phase 2: Clean State Testing

4. **Re-sweep ordinals** using corrected sweep process
5. **Test transfer** to verify the full round-trip works
6. **Identify root cause** - determine WHERE corruption happened

## Testing Environment

- **sweep-ui**: `examples/sweep-ui/` running at `http://localhost:4173`
- **Debug BRC-100 wallet**: Created from WIF, syncs with remote storage
- **Remote storage**: `https://api.1sat.app/1sat/wallet`
- **Sweep address**: `1DPbfnhdKsZwaYXZ96eARHKtb3ZUjeLdLf`

## Affected Ordinals

From investigation (8 total, 7 with BEEF OK, 1 corrupted vout):
- Need to diagnose customInstructions for all 7 "OK" ordinals
- The corrupted vout ordinal (`624a506a...1e7f.2`) has separate issues

## Key Files

**1sat-wallet-toolbox:**
- `examples/sweep-ui/src/components/DebugPanel.tsx` - Debug UI
- `src/api/sweep/index.ts` - Sweep implementation (lines 394-398 set customInstructions)
- `src/api/ordinals/index.ts` - Transfer implementation

**wallet-toolbox:**
- `src/storage/methods/createAction.ts#L393` - Where customInstructions is stored
- `src/storage/methods/listOutputsIdb.ts#L179` - Where it's retrieved

**go-wallet-toolbox:**
- `pkg/storage/internal/sync/chunk_processor.go#L378` - Sync passes through directly

## Progress Log

- [x] Identified transfer failure cause (corrupted customInstructions)
- [x] Investigated storage layer - confirmed NO encryption
- [x] Confirmed data is genuinely corrupted, not encrypted
- [x] Build diagnostic tool (DebugPanel.tsx)
- [ ] Diagnose all ordinals
- [ ] Repair customInstructions
- [ ] Transfer ordinals to sweep address
- [ ] Re-sweep from clean state
- [ ] Verify full round-trip works

## Diagnostic Tool

Added to `examples/sweep-ui/src/components/DebugPanel.tsx`:

### "Diagnose Selected" Button
For each selected ordinal:
1. Checks if current customInstructions is valid JSON
2. Fetches transaction from on-chain via OneSatServices
3. Finds corresponding input (input[n] → output[n] mapping)
4. Calculates expected customInstructions: `{"protocolID":[1,"onesat"],"keyID":"<input_outpoint>"}`
5. Derives address from protocolID/keyID using wallet's key derivation
6. Compares derived address to on-chain output address
7. Reports if addresses match (meaning data is repairable)

### "Repair Repairable" Button
For ordinals marked as repairable:
1. Opens IDB directly
2. Finds output record by txid+vout
3. Updates customInstructions with expected value
4. Closes transaction

### Usage
1. Open sweep-ui at http://localhost:4173
2. Go to "Ordinals Debug" tab
3. Click "Investigate Ordinals"
4. Select ordinals with checkboxes
5. Click "Diagnose Selected"
6. If any show "Repairable", click "Repair Repairable"
7. Click "Investigate Ordinals" again to verify
8. Try "Test Transfer Selected"
