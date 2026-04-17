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

Core TypeScript code lives in `src/`. Use `src/cmd/` for CLI entrypoints, `src/indexing/` for on-chain event indexing and seed data, `src/data/` for reward inputs, `src/utils/` for shared helpers, and `src/merkledb/` for Merkle database logic. Tests live in `tests/`, with reusable fixtures in `tests/harness/`. Operational assets include `.env.sample`, `Dockerfile`, and `bin/entrypoint.sh`.

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

`MockChain` starts at block 1, timestamp 0. Each slot advances time by `blockTime` before appending. So on the staking chain:

- slot 0 → block 1, t = 0 s
- slot 1 → block 2, t = 12 s
- slot k → block k+1, t = k × 12 s

Use `assertTimestamp` to catch arithmetic mistakes: place it on the slot that should fall exactly on a period boundary and the harness will throw if the actual timestamp differs.

### Minimum event sequence for a reward test

**Staking chain** (all events may share the first slot):

1. `ValidatorUpdated` – register the validator (`isRegistered: true`)
2. `StakeIncreased` – deposit self-stake for the primary staker; deposit delegated stake for any delegators
3. `SetDelegate` – (optional) set a commission beneficiary for a staker

**Consensus chain** (all events may share the first slot): 4. `ValidatorStakerSet` – bind `validator` → `staker` (used for commission routing fallback) 5. `KeyGenConfirmed` – admit the validator into the active signing group

Then, once the period window opens (i.e. after `fromTimestamp`), emit the full transaction lifecycle in one slot: 6. `TransactionProposed` – propose a transaction (`epoch`, `transaction`) 7. `Sign` – open a signing ceremony (`sid`, `message` = `transactionProposalMessage(...)`) 8. `SignShared` – one per participating validator (`sid`, `selectionRoot`, `participant`) 9. `SignCompleted` – close the ceremony (`sid`, `selectionRoot`) 10. `TransactionAttested` – finalise the transaction (`sid`)

Only transactions that complete this full lifecycle count toward participation.

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

The system spans two blockchains. Staking (stake deposits, validator registration, delegation, sanctions) happens on **Ethereum mainnet** via `STAKING_RPC_URL`. Consensus (transaction proposals, attestations, signing ceremonies) happens on **Gnosis Chain** via `CONSENSUS_RPC_URL`. Each chain has its own viem client, contract address, start block, and block page size. The `StakingData` class owns the staking related tables (which includes data from both Ethereum Mainnet and Gnosis Chain); `AttestationData` owns the consensus-related data (transaction attestations).

## Reward Algorithm Parameters

Key business-logic constants embedded in `src/safenet.ts`:

- **Participation threshold** – 75 %. Validators below this rate generate no rewards for themselves or their delegators.
- **Minimum self-stake for commission** – 3.5 M SAFE. Validators below this forfeit their 5 % commission on delegated stake but still earn rewards on their own self-stake.
- **Commission rate** – 5 % (500 bps) of rewards earned by delegated stake.
- **Minimum payout** – 1 SAFE. Amounts below this are carried forward as unpaid to the next period.
- **Stake weighting** – rewards scale with participation-weighted stake; large stakes use square-root weighting (`sqrtBigInt` in `src/utils/math.ts`).
- **All token amounts** use `bigint` with 18 decimal places. Use `formatSafeToken` in `src/utils/format.ts` for display and never convert to floating-point for arithmetic.

## CLI Argument / Environment Variable Convention

`src/utils/args.ts` uses Zod to parse both CLI flags and environment variables. CLI flags use **camelCase** (e.g. `--databaseFile`); env vars use **SCREAMING_SNAKE_CASE** (e.g. `DATABASE_FILE`). The mapping is automatic. The `rewardsPeriod()` helper in that file returns the most recently completed two-week **Tuesday-to-Tuesday UTC** window when `--rewardPeriodStart`/`--rewardPeriodEnd` are omitted.

## Event Indexing Patterns

All on-chain event indexers extend the abstract `EventIndexer` class in `src/indexing/events.ts`. Key behaviors:

- Fetches logs in configurable block-range pages with exponential backoff (`src/utils/backoff.ts`).
- Persists progress (last indexed block) in SQLite so subsequent runs are incremental.
- Some indexers ship **seed data** (pre-indexed historical events) under `src/indexing/seeds/` to avoid fetching from genesis. Add seed files there when a new historical dataset is needed.
- Indexers write into `StakingData` or `AttestationData`; they do not own their own tables.

## Record Directory & Merkle Distribution

The `--record` flag on several commands accepts the root of the `safenet-beta-data` repository. `MerkleDb` (`src/merkledb/index.ts`) writes cumulative payout data and Merkle proofs to `<record>/assets/rewards/`. The `cmd:rewards` command also emits a Safe transaction bundle to `<record>/assets/rewards/transactions/rewards-<periodEnd>.json` when `CUMULATIVE_MERKLE_DROP_ADDRESS` and `SAFE_TOKEN_ADDRESS` are set. `SAFE_TOKEN_ADDRESS` is fetched dynamically from the staking contract if not explicitly set via env.

## Key Dependencies

- **viem** – Ethereum/Gnosis RPC client; used for all `getLogs` / `readContract` calls.
- **better-sqlite3** – synchronous, in-process SQLite; used for all event caching and accounting queries.
- **zod** – schema validation for CLI args, env vars, and JSON file I/O.
- **debug** – structured debug logging; all log names are prefixed with `safenet:` and toggled via the `DEBUG` env var.
