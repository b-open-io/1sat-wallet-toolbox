# Indexer Review Progress

## Completed Indexers

### MapIndexer ✅
- Converted to static utility class (not extending Indexer)
- Has `parseMap()` static method for parsing MAP protocol data
- Used by InscriptionIndexer for embedded MAP data

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

## In Progress

### OriginIndexer 🔄
Current state in [OriginIndexer.ts](src/indexers/OriginIndexer.ts):

**Logic flow:**
1. Only parse 1-satoshi outputs, exclude BSV-20 tokens
2. Calculate satoshi position to find source input
3. If sourceOutpoint exists (transfer):
   - Fetch metadata from OrdFS `/v2/metadata/${outpoint}?map=true&parent=true`
   - Set origin, nonce, map, insc from metadata
4. If no sourceOutpoint (new origin):
   - Set `origin.outpoint = txo.outpoint.toString()`
5. Always merge current MAP data with inherited
6. Always overwrite inscription if current output has one
7. Validate parent against OrdFS if inscription claims one

**Dependencies:**
- `OneSatServices.getOrdfsMetadata()` - updated to use `/v2/metadata/${outpoint}?map=true&parent=true`
- `OrdfsMetadata` interface includes: outpoint, origin, sequence, contentType, contentLength, parent, map

**TODO:**
- [ ] Handle case when sourceOutpoint exists but OrdFS returns nothing (lines 86-91)
  - Current: leaves origin.outpoint empty
  - Issue: "If we have a sourceOutpoint, our outpoint is NOT the origin... ever"
  - Need different handling - user confirmed this needs to be addressed

## Pending Review

### OrdLockIndexer
- User requested to review after OriginIndexer is complete

### Bsv21Indexer
- User has this file open in IDE

### OpNSIndexer
- Not yet reviewed

### CosignIndexer
- Not yet reviewed

### TransactionParser
- Not yet reviewed

### parseAddress
- Not yet reviewed

## Reference Implementation
Using `./spv-store/src/indexers/` as reference for comparison.

## Key Files Modified This Session
- `src/indexers/OriginIndexer.ts` - main focus
- `src/indexers/MapIndexer.ts` - converted to static utility
- `src/indexers/InscriptionIndexer.ts` - added MapIndexer import
- `src/indexers/index.ts` - updated exports
- `src/services/OneSatServices.ts` - updated OrdfsMetadata interface and getOrdfsMetadata method
