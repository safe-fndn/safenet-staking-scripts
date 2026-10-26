# Agents

This file provides guidance to AI agents (such as Claude Code or OpenAI Codex) when working with code in this repository.

## Commands

```sh
npm ci                                   # install dependencies (Node.js 24+)
npm run check                            # Biome lint + tsc type-check (what CI runs)
npm run fix                              # Biome auto-fix
npm test                                 # run all Vitest tests
npm run test:watch                       # watch mode
npx vitest run tests/single.test.ts      # run one test file
npx vitest run -t "distributes rewards"  # run tests matching a name
npm run build                            # compile to dist/ (production only)
```

CI only runs `npm run check` — tests are not gated in CI, but run them locally when changing accounting logic.

## Project Structure & Module Organization

Core TypeScript code lives in `src/`. Use `src/cmd/` for CLI entrypoints, `src/config/` for the fixed Aegis deployment values, `src/indexing/` for on-chain event indexing and seed data, `src/data/` for reward inputs, `src/utils/` for shared helpers, and `src/merkledb/` for Merkle database logic. Versioned distribution inputs, such as `src/distribution/kyc.json`, live next to the module that loads them (see [Distribution Inputs](#distribution-inputs)). Tests live in `tests/`, with reusable fixtures in `tests/harness/`. Operational assets include `.env.sample`, `Dockerfile`, and `bin/entrypoint.sh`.

## Coding Style & Naming Conventions

This repository uses ESM TypeScript with `strict` mode enabled. Follow the existing style: tabs for indentation, double quotes, semicolons, and a 100-column line width enforced by Biome. Keep filenames lowercase with hyphenated or domain-specific names such as `validator-beneficiaries.ts`. Prefer small, focused modules and colocate command-specific logic under the matching `src/` area. Run `npm run fix` whenever you modify code to make sure it passes all lints.

## Testing Guidelines

Vitest is the test framework. Name tests `*.test.ts`, matching current patterns like `src/utils/ranges.test.ts` and `tests/single.test.ts`. Put pure unit tests next to the source file when that keeps context tight, and place scenario or harness-driven tests under `tests/`. Cover reward calculations, indexing edge cases, and period-boundary behavior when changing accounting logic.

## Adding Integration Tests

Integration tests live in `tests/` and are built around `createTestSafenet()` from `tests/harness/scenario.ts`, which wires a full `Safenet` instance against in-memory SQLite and two `MockChain` instances (no real RPC calls). The canonical reference is `tests/self-rewards.test.ts`.

### Harness helpers (`tests/harness/utils.ts`)

| Helper                             | Purpose                                                                                            |
| ---------------------------------- | -------------------------------------------------------------------------------------------------- |
| `namedAddress(name)`               | Deterministic address from a human-readable name; use for all actors                               |
| `parseSafe(amount)`                | Parse a decimal SAFE string to `bigint` with 18 decimals                                           |
| `emptyBlocks(n, opts?)`            | Create `n` empty block slots; pass `{ assertTimestamp: T }` on the last block to assert chain time |
| `transaction(seed)`                | Minimal `SafeTransaction` value unique to `seed`                                                   |
| `safeTxHash(tx)`                   | EIP-712 hash of a `SafeTransaction`                                                                |
| `signatureId(groupSeed, sequence)` | Signing-ceremony ID (`bytes32`)                                                                    |
| `selectionRoot(seed)`              | Deterministic selection-root hash                                                                  |
| `requestId(seed)`                  | Deterministic sentinel oracle request ID (`bytes32`)                                               |
| `transactionProposalMessage(...)`  | EIP-712 message hash for a `Sign` event                                                            |

### Scenario structure

```ts
const safenet = await createTestSafenet({
  staking:   { slots: [...] },  // Ethereum mainnet, blockTime = 12 s
  consensus: { slots: [...] },  // Gnosis Chain,     blockTime = 5 s
});
```

Each element in `slots` is either a `BlockSpec` (`{ events?, assertTimestamp? }`) or `null` (skips a block number without emitting a block, still advances time by one `blockTime`). `emptyBlocks(n)` returns `n` non-null, event-less `BlockSpec` objects.

### Block timing

`MockChain` starts at block 1, timestamp 0 (or the scenario's `genesisTimestamp`, which offsets every timestamp below). Each slot advances time by `blockTime` before appending. So on the staking chain:

- slot 0 → block 1, t = 0 s
- slot 1 → block 2, t = 12 s
- slot k → block k+1, t = k × 12 s

Use `assertTimestamp` to catch arithmetic mistakes: place it on the slot that should fall exactly on a period boundary and the harness will throw if the actual timestamp differs.

Block 0 is an empty genesis block that shares timestamp 0 with block 1, so that block lookups can search from block 0 when no start block is configured.

Validator and sentinel participation only count transaction attestations and reveals up to the period's settlement block, `SETTLEMENT_BLOCKS` (48) consensus blocks after the last consensus block at or before `toTimestamp`. Every period query (`rewards`, `participation`, `validatorStats`, `staked`, `sentinelParticipation`, `sentinelRewards`) fails while that block does not exist, and indexes every indexer, on both chains, up to the settlement block's timestamp. Scenarios that query them must extend the consensus chain with `...emptyBlocks(Number(SETTLEMENT_BLOCKS))` past the end of the period, and the staking chain up to at least the settlement timestamp.

### Minimum event sequence for a reward test

**Staking chain** (all events may share the first slot):

1. `ValidatorUpdated` – register the validator (`isRegistered: true`)
2. `StakeIncreased` – deposit self-stake for the primary staker; deposit delegated stake for any delegators
3. `SetDelegate` – (optional) set a commission beneficiary for a staker

**Consensus chain** (all events may share the first slot): 4. `ValidatorStakerSet` – bind `validator` → `staker` (used for commission routing fallback) 5. `KeyGenConfirmed` – admit the validator into the active signing group

Then, once the period window opens (i.e. after `fromTimestamp`), emit the full transaction lifecycle in one slot: 6. `TransactionProposed` – propose a transaction (`epoch`, `transaction`) 7. `Sign` – open a signing ceremony (`sid`, `message` = `transactionProposalMessage(...)`) 8. `SignShared` – one per participating validator (`sid`, `selectionRoot`, `participant`) 9. `SignCompleted` – close the ceremony (`sid`, `selectionRoot`) 10. `TransactionAttested` – finalise the transaction (`sid`)

Only transactions that complete this full lifecycle count toward participation, and only if `SignCompleted` is inside the period and `TransactionAttested` is no later than the period's settlement block.

### Commission routing order

For each validator, the 5 % commission on delegated-stake rewards is sent to the first of:

1. The address set via `SetDelegate` on the staking chain for the validator's staker (cleared by `ClearDelegate`)
2. The staker registered via `ValidatorStakerSet` on the consensus chain
3. The validator address itself (fallback when neither is set)

`SetDelegate`/`ClearDelegate` events are effective at the timestamp they appear, so a `ClearDelegate` mid-period shifts commission routing for the remainder of that period.

### Writing assertions

Pre-compute exact `bigint` values and annotate the arithmetic in a comment directly above the assertion block:

```ts
// 4 validators each with 4.5 M total stake at 100% participation
// each gets 25,000 SAFE; self reward = 25000 × 3.5M/4.5M ≈ 19,444.44 SAFE
const { payouts, unpaid } = await safenet.rewards(
    { fromTimestamp: 60n, toTimestamp: 120n },
    parseSafe("100000"),
);
expect(payouts).toEqual({ [namedAddress("staker")]: parseSafe("...") });
expect(unpaid).toBe(4n); // rounding residue; assert explicitly
```

Use `expect(payouts).toEqual(...)` (not just `toBeDefined`) and always assert `unpaid` separately — rounding residue is part of the accounting contract.

## Two-Chain Architecture

The system spans two blockchains. Staking (stake deposits, validator registration, delegation, sanctions) happens on **Ethereum mainnet** via `STAKING_RPC_URL`. Consensus (transaction proposals, attestations, signing ceremonies) happens on **Gnosis Chain** via `CONSENSUS_RPC_URL`. Each chain has its own viem client and block page size, which are configuration, and its own contract addresses and start blocks, which are fixed for Aegis in `src/config/aegis.ts`. The `StakingData` class owns the staking related tables (which includes data from both Ethereum Mainnet and Gnosis Chain); `AttestationData` owns the consensus-related data (transaction attestations); `SentinelData` owns the sentinel oracle data (requests and reveals), which also lives on Gnosis Chain.

`SanctionsData` (`src/data/sanctions.ts`) owns the `sanctions` table and combines two independent sources behind one `sanctionedAccounts()` method: the on-chain Chainalysis oracle (indexed and timestamped like any other chain event, via the `Sanctions` indexer in `src/indexing/sanctions.ts`) and the UN/EU/UK/Swiss SECO/US OFAC address lists published as release assets of the `sanctionsAddressRepo` GitHub repository (`owner/name`, `safe-fndn/sanctions-address-lists` for Aegis), fetched through the unauthenticated releases client in `src/utils/gh.ts` (`releaseTags`, `releaseAsset`). Those have no on-chain timestamp, so `sanctionedAccounts()` fetches them live from the moving `latest` release, while `pinnedSanctionedAccounts()` pins them to the period's `data-YYYY-MM-DD` snapshot release (the newest whose UTC day ended at or before `toTimestamp`, see `selectSnapshotRelease`) and returns the release alongside the accounts. `StakingData`'s `selectStakeAmounts`/`selectStakers` queries also read the `sanctions` table directly, so `Safenet.create` must construct `SanctionsData` before `StakingData`.

## Reward Algorithm Parameters

Key business-logic constants embedded in `src/safenet.ts`:

- **Participation threshold** – 75 %. Validators below this rate generate no rewards for themselves or their delegators.
- **Minimum self-stake for commission** – 3.5 M SAFE. Validators below this forfeit their 5 % commission on delegated stake but still earn rewards on their own self-stake.
- **Commission rate** – 5 % (500 bps) of rewards earned by delegated stake.
- **Minimum payout** – 1 SAFE. Amounts below this are carried forward as unpaid to the next period.
- **Sentinel participation threshold** – 70 %. Sentinels at or above this rate each receive the full per-sentinel grant; below it, the grant is forfeited rather than carried forward.
- **Stake weighting** – rewards scale with participation-weighted stake; large stakes use square-root weighting (`sqrtBigInt` in `src/utils/math.ts`).
- **All token amounts** use `bigint` with 18 decimal places. Use `formatSafeToken` in `src/utils/format.ts` for display and never convert to floating-point for arithmetic.

## CLI Argument / Environment Variable Convention

`src/utils/args.ts` uses Zod to parse both CLI flags and environment variables. CLI flags use **camelCase** (e.g. `--databaseFile`); env vars use **SCREAMING_SNAKE_CASE** (e.g. `DATABASE_FILE`). The mapping is automatic. The `rewardsPeriod()` helper in that file returns the most recently completed two-week **Tuesday-to-Tuesday UTC** window when `--rewardPeriodStart`/`--rewardPeriodEnd` are omitted. The one exception is `GITHUB_TOKEN`, which `src/utils/gh.ts` reads directly from `process.env` on each GitHub API request, so it never passes through argument parsing.

Only values that are expected to change are configuration: the RPC URLs, block page sizes, `DATABASE_FILE`, `IPFS_GATEWAY_URL`, `GITHUB_TOKEN` and `DEBUG`. The fixed Aegis values (contract addresses and start blocks, the Cumulative Merkle Drop, the Reality Module, the rewards ENS name and the sanctions lists repository) live in `src/config/aegis.ts`, and the commands pass them as `AEGIS_PARAMETERS` alongside their parsed arguments. Library functions such as `Safenet.create` and `exportPackage` keep taking them as parameters and never import `aegis.ts`, so that tests can pass their own.

## Event Indexing Patterns

All on-chain event indexers extend the abstract `EventIndexer` class in `src/indexing/events.ts`. Key behaviors:

- Fetches logs in configurable block-range pages with exponential backoff (`src/utils/backoff.ts`).
- Persists progress (last indexed block) in SQLite so subsequent runs are incremental.
- Some indexers ship **seed data** (pre-indexed historical events) under `src/indexing/seeds/` to avoid fetching from genesis. Add seed files there when a new historical dataset is needed.
- Indexers write into `StakingData`, `AttestationData` or `SentinelData`; they do not own their own tables.

## Database Schema Conventions

The SQLite database is an event cache that grows monotonically with chain history, so schema
decisions that look harmless at small scale dominate the file size later. When adding or changing
tables:

- **Never store a repeated address or hash inline in a high-cardinality table.** Give it an integer
  surrogate key in its own lookup table and reference that key instead. `participants` and
  `signing_participants` in `src/data/attestations.ts` are the reference implementation: one row per
  address in the lookup table, and the per-event table stores only integers. SQLite does no
  deduplication of repeated text on its own, and retrofitting a lookup table later means a
  re-index. This has already caused real database size problems with the validator tables.
- **Identify the table that grows fastest** (one row per participant per event, rather than one row
  per event) and make that the one carrying nothing but integers.
- **`PRIMARY KEY(id)` on an `INTEGER` column is a rowid alias**, so such tables must be rowid
  tables. Use `WITHOUT ROWID` only when the primary key is a composite of narrow columns, as in
  `signing_participants`.
- **Only use `AUTOINCREMENT` when rows get deleted.** It guarantees a row ID is never reused for
  the lifetime of the database, which matters for `selections` (whose rows are cleaned up after
  use, leaving deliberately dangling references) and nowhere else. It requires an awkward
  `INSERT … SELECT … WHERE NOT EXISTS` upsert to avoid burning IDs, so do not copy that pattern
  into tables that never delete.
- **Drop columns that are never queried.** `signing_participants` has no timestamp because shares
  are only ever counted through their ceremony; an unused column is both dead weight and an
  invitation to filter on it by accident.
- **Discard unindexed event payload you do not need**, such as long `string` fields, rather than
  storing them for hypothetical future use.

## Record Directory & Merkle Distribution

The `--record` flag on several commands accepts the root of the `safenet-data` repository. `MerkleDb` (`src/merkledb/index.ts`) is rooted at a rewards directory (`new MerkleDb({ root })`), where it writes cumulative payout data and Merkle proofs; the commands derive it from `--record` as `<record>/assets/rewards/` (`recordRewardsDirectory()` in `src/utils/args.ts`). With `--transactions <dir>`, `cmd:rewards` and `cmd:kyc` also emit a Safe transaction bundle to `<dir>/rewards-<periodEnd>.json` and `<dir>/kyc-<periodEnd>.json` respectively, calling the Aegis Cumulative Merkle Drop, and the SAFE token address is read from the staking contract. Transaction bundles are never written into the rewards directory, which must contain only `latest.json` and `proofs/`. `transactionBundle()` in `src/utils/bundle.ts` builds a bundle as a pure function of its transactions and `createdAt`.

## Distribution Inputs

Some inputs to a distribution are neither onchain nor program constants set by the DAO (those live in `src/utils/sep.ts`). They are JSON files under `src/`, imported with `with { type: "json" }` and validated with zod, so `tsc` emits them into `dist/` and they are part of the build rather than read from disk at runtime. Because they are versioned with the code, the commit that produced a distribution pins them too.

`src/distribution/kyc.json` holds the KYC threshold and the complete list of KYC-approved accounts. `kyc()` in `src/distribution/kyc.ts` returns them validated against a zod schema:

```json
{
	"accounts": ["0x…"],
	"threshold": "7500"
}
```

- `threshold` is a decimal amount of whole SAFE tokens (parsed with `parseUnits(…, 18)`). Payouts at or above it are withheld in `kycAmount` for accounts that are not approved.
- `accounts` are checksummed and sorted by address bytes (`sortByAddress`), with no duplicates. The zod schema rejects anything else, so a broken manual edit fails every command that loads the file, and `tests/kyc.test.ts`.
- SEF edits the file manually through reviewed PRs. Approving an account means adding it in sorted position. Approvals are sticky: removing an account does not revoke its approval, and `MerkleDb.distribute` refuses to run while an account flagged `kyc: true` in the rewards DB is missing from the file, so never remove one.
- `MerkleDb.distribute` takes the accounts as `Filters.kycApprovals`. It flags each one before the period's payouts, releasing any withheld amount in the same rebuild, and returns the accounts that were not flagged yet as `newlyApproved`. `cmd:rewards` defaults `--kycThreshold` to the file's threshold and always passes the file's accounts.
- `MerkleDb.kyc(period, approvals, sanctions)` applies the same complete list between distributions, with the same refusal and `newlyApproved`, and only for the period the rewards DB was last distributed to. `cmd:kyc` always passes the file's accounts and takes none on the command line, so the file is the only way to approve an account.

## Key Dependencies

- **viem** – Ethereum/Gnosis RPC client; used for all `getLogs` / `readContract` calls.
- **better-sqlite3** – synchronous, in-process SQLite; used for all event caching and accounting queries.
- **zod** – schema validation for CLI args, env vars, and JSON file I/O.
- **debug** – structured debug logging; all log names are prefixed with `safenet:` and toggled via the `DEBUG` env var.
