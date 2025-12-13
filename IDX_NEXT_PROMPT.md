# Indexer Review Progress

## Completed Indexers

### MapIndexer ✅
- Restored to proper Indexer class (was incorrectly converted to static-only utility)
- Has `parse()` method for standalone MAP protocol OP_RETURN data
- Has `parseMap()` static method for parsing MAP protocol data (used by InscriptionIndexer)
- Matches reference implementation in spv-store

### InscriptionIndexer ✅
- Updated to use `MapIndexer.parseMap()` for embedded MAP data in inscriptions
- Parses ordinal inscriptions (OP_FALSE OP_IF "ord" envelope)
- Sets owner from address parsing

### SigmaIndexer ✅
- Confirmed no need for `insc` check
- Not setting owner from sigma signature

### FundIndexer ✅
- Basic fund tracking

### LockIndexer ✅
- Lock tracking

### OriginIndexer ✅
- Fixed error handling for OrdFS lookups
- Created `HttpError` class in `src/errors.ts` for granular HTTP error handling
- Updated `OneSatServices` to throw `HttpError` instead of returning undefined/swallowing errors
- When sourceOutpoint exists but OrdFS returns 404: returns undefined (skip indexing)
- When parent validation fails with 404: removes parent claim
- Other HTTP errors propagate up

### OrdLockIndexer ✅
- Fixed `summarize()` to check `spend.data[this.tag]` first, then check unlocking script for SUFFIX
- Distinguishes purchased (amount: 1) vs cancelled (amount: 0) vs created (amount: -1)
- Added serialize/deserialize methods for BigInt-safe JSON handling

### Bsv21Indexer ✅
- Updated to handle `HttpError` from `getBsv21TokenByTxid()` (404 = mark token as pending)
- Fixed BigInt comparison: `2n ** 64n - 1n` instead of `BigInt(2 ** 64 - 1)`
- Added serialize/deserialize methods for BigInt-safe JSON handling
- Added `getBsv21TokenDetails(tokenId)` to OneSatServices with caching (for future use)
- Reviewed summarize() validation logic - correct: pending cascades, counts all balances regardless of status

### OpNSIndexer ✅
- Extends reference with `txo.basket = "opns"` categorization
- Extracts `name` from JSON content for owned outputs and adds as tags
- TODO for OpNS server validation noted (infrastructure not ready)
- No issues found

### CosignIndexer ✅
- Nearly identical to reference
- Uses strict equality `===` (better practice)
- Adds `tags: []` to return value (consistent with other indexers)
- No issues found

### TransactionParser ✅
- **BUG FIXED**: `parseInputs()` was creating single-element `txos[]` array but passing `sourceVout` to indexers
  - Indexers access `ctx.txos[vout]`, so when `sourceVout > 0` they got `undefined`
  - Fixed by building full `txos[]` array with all source transaction outputs
- Removed unused `MapIndexer` from OneSatWallet.ts indexers array (was causing build error)

### parseAddress ✅
- Nearly identical to reference
- Uses strict equality `!==` (better practice)
- Uses union type `"mainnet" | "testnet"` instead of Network type alias
- Added JSDoc comments
- No issues found

## In Progress

## Pending Review

## Reference Implementation
Using `./spv-store/src/indexers/` as reference for comparison.

## Key Files Modified This Session
- `src/errors.ts` - NEW: Created `HttpError` class for granular HTTP error handling
- `src/indexers/OriginIndexer.ts` - Fixed error handling, uses HttpError
- `src/indexers/OrdLockIndexer.ts` - Fixed summarize(), added serialize/deserialize
- `src/indexers/Bsv21Indexer.ts` - Fixed BigInt, added serialize/deserialize, HttpError handling
- `src/services/OneSatServices.ts` - Added HttpError throws, added `getBsv21TokenDetails()` with cache, added `Bsv21TokenDetails` interface
- `src/indexers/TransactionParser.ts` - Fixed parseInputs() bug where txos array was single-element but vout > 0
- `src/indexers/MapIndexer.ts` - Restored to proper Indexer class with parse() method for standalone MAP OP_RETURN
- `src/OneSatWallet.ts` - Restored MapIndexer to indexers array

## Infrastructure Changes
- All HTTP fetches in OneSatServices now throw `HttpError` on failure (not swallowing errors)
- Pattern: catch `HttpError`, check `e.status === 404` for not-found handling
- BigInt serialization pattern established with serialize/deserialize methods

## External APIs Discovered
- BSV21 Overlay (`/home/shruggr/Code/bsv21-overlay`):
  - `GET /api/1sat/bsv21/{tokenId}` - token details (sym, dec, icon, amt)
  - `GET /api/1sat/bsv21/{tokenId}/tx/{txid}` - transaction with inputs/outputs
