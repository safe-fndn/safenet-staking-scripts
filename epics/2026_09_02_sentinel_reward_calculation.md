# Plan: Sentinel Reward Calculation

## Overview

Sentinels answer Safenet oracle requests through a commit/reveal scheme on the sentinel oracle
contract(s). This epic adds sentinel participation tracking and sentinel reward payouts to the
accounting scripts, distributed through the **same** cumulative Merkle drop as validator rewards.

The work breaks down into:

1. **Data layer** — a `SentinelData` class owning four new SQLite tables (two lookup tables,
   requests, reveals) plus the participation query.
2. **Indexing** — a `SentinelOracle` event indexer (`NewRequest`, `Revealed`) for the canonical
   oracle contract, wired into `Safenet.index()` and the CLI/env configuration.
3. **Test harness** — sentinel oracle event encoding in `tests/harness/`, plus
   `Safenet.sentinelParticipation()` and its integration test.
4. **`cmd:participation`** — print validator and sentinel participation together, with a
   `--category` filter.
5. **Merkle DB accounting** — track the sentinel-distributed total separately in `latest.json` so
   the existing validator budget proration stays correct (**required**, see Tech Specs).
6. **Reward calculation** — `Safenet.sentinelRewards()`: fixed per-sentinel amount, prorated by
   period duration, gated on a 70 % participation threshold.
7. **`cmd:rewards`** — merge sentinel payouts into the single Merkle distribution and the Safe
   transaction bundle.
8. **Cleanup** — remove this specification file.

Phases 1 → 2 → 3 are sequential. Phase 5 is independent of 3/4 and can be developed in parallel.
Phase 6 depends on 3. Phase 7 depends on 5 and 6.

---

## Architecture Decision

The sentinel oracle lives on the **consensus chain** (Gnosis Chain), so it reuses
`CONSENSUS_RPC_URL`, `consensusClient`, and `CONSENSUS_BLOCK_PAGE_SIZE`. No new chain, no new RPC
client, no new `viem` transport.

### A single canonical oracle contract

There is always exactly one canonical sentinel oracle, and it is **required** configuration — not
an optional feature flag. `SentinelOracle` is therefore an ordinary `EventIndexer` named
`sentinel-oracle`, constructed exactly like `Signatures` or `Sanctions` and configured with a plain
`SENTINEL_ORACLE_ADDRESS` / `SENTINEL_ORACLE_START_BLOCK` pair. Consequences:

- No changes to `EventIndexer` — the largest and most delicate piece of existing machinery.
- `Safenet.index()`'s `Promise.all` list simply gains one more entry.
- Nothing downstream needs an "is sentinel indexing enabled?" branch: `ConsensusChain.oracle` is
  non-nullable, and `sentinelParticipation()` / `sentinelRewards()` always have a denominator to
  query. A period with no requests is an ordinary zero, not a special case.
- `EventIndexer`'s existing `contract` (`chainId:address`) guard already refuses to run against a
  database that was indexed for a different address, so re-pointing the oracle at a redeployment
  fails loudly instead of silently mixing two contracts' requests.

### New `SentinelData` class, not an extension of `AttestationData`

`AttestationData` models FROST signing ceremonies; sentinel commit/reveal is a different domain with
a different denominator. A third data class (`src/data/sentinels.ts`) sharing the same `Database`
handle keeps both query sets legible, matching the existing `StakingData` / `AttestationData` split.

### Participation attribution mirrors validator ceremony attribution

Participation is `reveals / requests`, where the **request** is the unit of attribution: a request
is assigned to the period containing its `NewRequest` block timestamp, and reveals are counted by
joining onto that request — not by their own timestamps.

This is structurally the same as the existing validator calculation, which attributes a signing
ceremony to a period by its `SignCompleted` timestamp and then joins `signing_participants` with no
timestamp predicate at all. In both cases a participation event may fall in a different period than
the unit it is attributed to, and both numerator and denominator are keyed on the same unit — so the
rate is always in `[0, 1]` and never double counts.

The consequence, documented under Assumptions, is that a request created near the end of a period
may still have reveals arriving after the period boundary.

### Sentinel rewards ride the existing Merkle drop, in a single `distribute()` call

`MerkleDb.distribute()` rebuilds the whole tree and stamps `index.rewardsUntil`; a second call for
the same period returns `null`. Sentinel payouts must therefore be **merged into the same
`payouts` map** as validator payouts in one call, not distributed separately. Both programs are
funded from the same treasury Safe, so the transaction bundle keeps its existing two-transaction
shape (`setMerkleRoot` + a single `transfer` covering the combined amount).

### Alternatives Considered

- **Supporting a configurable set of oracle contracts** (either by teaching `EventIndexer` to
  filter on an address array, or by instantiating one indexer per configured oracle). This was the
  original design, and it carried a real hazard: two operators configuring *different* oracle sets
  would compute different participation denominators from the same chain data. Rejected once the
  oracle was settled as canonical — a single address is both simpler and unambiguous.
- **A "grace-shifted" participation window.** Shift the denominator window back by a configured
  number of seconds (`[from - grace, to - grace)`) so that every request's reveal phase has closed
  before it is counted. This removes the boundary effect entirely, but introduces a tuning
  parameter with no on-chain ground truth (reveal deadlines are per-request block numbers chosen by
  the sponsor) and diverges from how validator participation already works. Rejected in favour of
  matching the validator behaviour.
- **Exact reveal-window filtering.** Exclude requests whose `revealDeadline` block had not been
  reached by the period end, comparing against the indexer's `last_block_number` in
  `event_indexers` (which is exactly the last block at or before `toTimestamp` after
  `index(period)`) — precise and RPC-free. Rejected because an excluded request would fall through
  the cracks entirely: the next period's window is keyed on `NewRequest` timestamp, so it would
  never be counted at all. Making it roll forward requires the grace shift above.
- **Attributing reveals by their own timestamp** (two independent counts rather than a join).
  Simpler still, but the rate can then exceed 100 % and it is noisy in the first period and at low
  request volume, which makes a 70 % cliff hard to defend. Rejected.
- **A separate Merkle drop contract for sentinels.** Explicitly out of scope: the requirement is to
  reuse the existing drop, and doing so also inherits sanctions filtering and KYC handling for free.
- **Indexing `Committed` and/or maintaining a sentinel allowlist.** Neither is needed for reward
  correctness: failing to reveal is not participation, and a sentinel with zero reveals has a 0 %
  rate and is ineligible regardless of whether we know it exists. Surfacing committed-but-unrevealed
  liveness failures is a monitoring concern, not a rewards concern. Out of scope.

---

## Tech Specs

### ABI additions (`src/abi.ts`)

```ts
export const SENTINEL_ORACLE_ABI = parseAbi([
	"event NewRequest(bytes32 indexed requestId, address indexed sponsor, uint96 fee, uint96 bondTarget, uint96 slashAmount, uint64 commitDeadline, uint64 revealDeadline)",
	"event Revealed(bytes32 indexed requestId, address indexed sentinel, bool approved, uint96 bondAmount, string reason)",
]);
```

Both events are declared in `internal` libraries (`SentinelOracleRequestMap`,
`SentinelOracleCommitmentMap`) and are therefore emitted from the calling `SentinelOracle` contract
address, which is what the indexer filters on.

### Schema (`src/data/sentinels.ts`)

Every repeated value gets an integer surrogate key and lives in its own lookup table, so that the
high-cardinality table (`sentinel_reveals`, one row per sentinel per request) stores nothing but
integers. This follows the `participants` / `signing_participants` pattern in `AttestationData`,
which exists precisely because storing repeated address and hash text inline blew up the database
size for the validator tables.

```sql
CREATE TABLE IF NOT EXISTS sentinel_oracles(
	id INTEGER NOT NULL,
	contract TEXT NOT NULL,             -- 'chainId:0xChecksummedAddress'
	PRIMARY KEY(id),
	UNIQUE(contract)
);

CREATE TABLE IF NOT EXISTS sentinels(
	id INTEGER NOT NULL,
	address TEXT NOT NULL,
	PRIMARY KEY(id),
	UNIQUE(address)
);

CREATE TABLE IF NOT EXISTS sentinel_requests(
	id INTEGER NOT NULL,
	oracle INTEGER NOT NULL,            -- -> sentinel_oracles(id)
	request_id TEXT NOT NULL,
	block_timestamp INTEGER NOT NULL,   -- NewRequest block timestamp
	PRIMARY KEY(id),
	UNIQUE(oracle, request_id)
);
CREATE INDEX IF NOT EXISTS sentinel_request_block_timestamp_idx
ON sentinel_requests(block_timestamp);

CREATE TABLE IF NOT EXISTS sentinel_reveals(
	request INTEGER NOT NULL,           -- -> sentinel_requests(id)
	sentinel INTEGER NOT NULL,          -- -> sentinels(id)
	approved INTEGER NOT NULL,
	PRIMARY KEY(request, sentinel)
) WITHOUT ROWID;
```

Why this shape:

- **`sentinel_reveals` is the table that grows fastest** — one row per sentinel per request. Storing
  the oracle identifier (~50 chars), `requestId` (66 chars) and sentinel address (42 chars) inline
  meant ~160 bytes of duplicated text per reveal; three integers is a small fraction of that, and
  SQLite would not deduplicate any of it on its own.
- **`request_id` is text only in `sentinel_requests`**, once per request, with the integer `id` used
  as the foreign key everywhere else.
- **`sentinel_oracles` and `sentinels` are plain lookup tables.** `PRIMARY KEY(id)` on an `INTEGER`
  column makes `id` a rowid alias, so these tables are rowid tables — exactly like `participants`
  and `signing_ceremonies`. Only `sentinel_reveals`, whose primary key is a pair of integers, stays
  `WITHOUT ROWID`, mirroring `signing_participants`.
- **No `AUTOINCREMENT`.** `AttestationData` needs it for `selections` only because those rows get
  deleted and a reused row ID would corrupt the data; sentinel rows are never deleted, so the
  plain rowid alias is correct here and the `AUTOINCREMENT`-friendly upsert dance is unnecessary.
- **Requests are scoped by `oracle`** via `UNIQUE(oracle, request_id)`. With a single canonical
  oracle this is not strictly load-bearing, but it costs one integer column and keeps a `requestId`
  unique to the contract that issued it, which matters if the oracle is ever redeployed.
- **`sentinel_reveals` deliberately carries no `block_timestamp`**, mirroring
  `signing_participants`: reveals are only ever counted through their request, so the column would
  be dead weight and an invitation to filter on it by accident.
- The `Revealed` event's `string reason` is **discarded** to keep the database small — following the
  precedent of the selection-root cleanup in `AttestationData.registerSignatureCompleted`. The
  `approved` flag is kept: it costs nothing and makes vote splits inspectable.
- A `Revealed` event whose `NewRequest` was never indexed — i.e. the request predates the oracle's
  configured `startBlock` — must be **skipped**, not inserted. With a `NOT NULL` surrogate foreign
  key there is no row to point at, so the insert has to be guarded (`INSERT … WHERE EXISTS (SELECT
  1 FROM sentinel_requests …)`) rather than left to resolve a `NULL` subquery and throw. Skipping
  is also the correct accounting outcome: the request is absent from the denominator, so its
  reveals must be absent from the numerator. Note this is a behavioural difference from the
  text-keyed schema, where such a row could be stored and filtered out later by the join.
- **Event ordering is guaranteed here**, unlike in `AttestationData`. Both events come from the
  same indexer for a given oracle, logs are sorted by `(blockNumber, logIndex)` within a page, and
  pages advance monotonically — so a `Revealed` can never be seen before its own `NewRequest`.
  `AttestationData.registerTransactionAttestation` needs its defensive upsert only because
  `Transactions` and `Signatures` are separate, concurrently running indexers; that hazard does not
  apply, and the guard above is for the `startBlock` case only.

Public API mirrors `AttestationData` — callers pass addresses and hashes, and the surrogate keys
stay an implementation detail behind the prepared statements, exactly as `registerParticipant` and
`registerSignatureShare` do today:

```ts
registerOracle({ contract }): void
registerRequest({ contract, requestId, blockTimestamp }): void
registerReveal({ contract, requestId, sentinel, approved }): void
participation(period: TimestampRange): SentinelParticipationSummary
requestCount(period: TimestampRange): number
```

`registerRequest` upserts into `sentinel_oracles` and `registerReveal` upserts into `sentinels`
before inserting, following `registerSignatureShare`'s upsert-then-insert pattern, so events
arriving in any order still resolve their foreign keys.

where

```ts
export type SentinelParticipationSummary = {
	total: number;                          // requests created in the period
	sentinels: Record<Address, number>;     // reveals per sentinel, for those requests
};
```

The participation query is an `INNER JOIN` of `sentinel_reveals` onto `sentinel_requests` on the
integer `request` key, filtered by the request's `block_timestamp` and grouped by `sentinel`, with
a final join onto `sentinels` to map the surrogate key back to an address — the same shape as
`selectParticipation` in `AttestationData`.

### `Safenet` API additions (`src/safenet.ts`)

```ts
export type SentinelParticipation = {
	total: number;
	sentinels: Record<Address, number>;
};

export type SentinelRewards = {
	payouts: Record<Address, bigint>;
	forfeited: bigint;   // grants not awarded because participation was below threshold
};

async sentinelParticipation(period: TimestampRange): Promise<SentinelParticipation>
async sentinelRewards(period: TimestampRange, perSentinel: bigint): Promise<SentinelRewards>
```

`RewardSplit` gains a third field so a single payouts map can carry both programs:

```ts
export type RewardSplit = {
	stakeRewards: bigint;
	commission: bigint;
	sentinelRewards: bigint;   // new
};
```

`forfeited` is **not** folded into the validator `unpaid` figure. `unpaid` means "current-period
rounding dust carried forward" (see commit `d5b8159`), whereas a forfeited sentinel grant is simply
never spent — there is no dust and nothing to carry. It is reported separately in the command output
for visibility only.

### Business-logic constants

Placed alongside the existing constants in `src/safenet.ts` / `src/utils/args.ts`:

| Constant                         | Value                              | Notes                                                        |
| -------------------------------- | ---------------------------------- | ------------------------------------------------------------ |
| Sentinel participation threshold | 70 %                               | Hard-coded, like the validator 75 % threshold                 |
| `SENTINEL_REWARD_PER_YEAR`       | 400 000 SAFE                       | Per **eligible** sentinel. Hard-coded, like `TOTAL_REWARDS`   |
| `SENTINEL_REWARDS_PERIOD`        | `60 * 60 * 24 * 7 * 52`            | 52 weeks, matching the validator `26`-week unit convention    |

All three are **hard-coded constants, not configuration.** This mirrors the validator program,
where `TOTAL_REWARDS` (4.5 M) and `TOTAL_REWARDS_PERIOD` (26 weeks) are constants in
`src/utils/args.ts` and only the computed per-period amount is overridable, via `--totalRewards`.
Sentinels get the exact analogue: `--sentinelRewards` overrides the computed per-period,
per-sentinel amount, and there is no separate flag for the annual rate. Updating the annual figure
after the DAO proposal is finalised is a one-line constant change, the same as it would be for
`TOTAL_REWARDS`.

Per-period amount per eligible sentinel:

```
periodAmount = SENTINEL_REWARD_PER_YEAR * (toTimestamp - fromTimestamp) / SENTINEL_REWARDS_PERIOD
```

Eligibility is binary — every sentinel at or above 70 % receives the full `periodAmount`. There is
no pool to divide, no staking requirement, no delegation, and no commission. The aggregate cap is
enforced upstream by the oracle's sentinel allowlist rather than by this script: the proposed DAO
formulation is *"allocate the 2,000,000 SAFE grant across five Sentinels, corresponding to 400,000
SAFE per Sentinel per year, prorated to the selected distribution period"*, i.e. the 400 000 default
times the known maximum sentinel count.

Unlike `totalRewardsAmount()`, there is deliberately **no** cumulative catch-up against
`latest.json`: the spend per period depends on how many sentinels were eligible, so a
"total distributed so far" reconciliation is not well defined. The amount is a pure duration
proration.

The **1 SAFE minimum payout** is *not* applied to sentinel rewards in this epic. It currently lives
inside `Safenet.rewards()` and applies to the validator payout map only; applying it to the merged
validator + sentinel list is the right end state but requires lifting that filter out of
`rewards()`, which is deferred to the planned rewards-refactoring epic rather than duplicated here.
The **KYC threshold** needs no such work — it is applied by `MerkleDb.#distributeTo` at distribute
time, so it already covers the merged list for free.

### Configuration

New variables, following the existing camelCase-flag / `SCREAMING_SNAKE_CASE`-env convention in
`src/utils/args.ts`:

| Variable                      | CLI flag                       | Description                                                                 |
| ----------------------------- | ------------------------------ | --------------------------------------------------------------------------- |
| `SENTINEL_ORACLE_ADDRESS`     | `--sentinelOracleAddress`      | Address of the canonical sentinel oracle contract, on the consensus chain. Required. |
| `SENTINEL_ORACLE_START_BLOCK` | `--sentinelOracleStartBlock`   | Block the sentinel oracle was deployed on. Required. |
| `SENTINEL_REWARDS`            | `--sentinelRewards`            | Per-period, per-sentinel override, in whole SAFE (analogous to `--totalRewards`). |

There is deliberately **one** reward flag, not two. An annual-rate flag alongside a per-period
override would leave "what happens if both are given?" to resolve, for no gain: the annual rate is
a program constant (see above), and the only thing an operator ever needs to override is the
resulting per-period amount.

The address/start-block pair follows the existing `CONSENSUS_ADDRESS` / `CONSENSUS_START_BLOCK`
convention exactly — the same required `z.string().transform((a) => getAddress(a))` and
`z.coerce.bigint()` fields used for every other contract.

Because they are required, **every command fails to start without them**, including ones that have
nothing to do with sentinels. This is deliberate: a missing oracle would otherwise silently produce
an empty participation denominator, and an operator who has not configured the oracle is not in a
position to compute correct rewards either. The cost is that `.env` files must be updated in
lockstep with this change; `.env.sample` ships a clearly marked placeholder address and start block
so that `cp .env.sample .env` still parses.

#### Configured oracle versus indexed sentinel set

Only the first of these is configuration:

- **Which oracle contract to index** is required configuration — a single canonical address, the
  same way `CONSENSUS_ADDRESS` is required configuration. Misconfiguring it is the same class of operator error as
  pointing `CONSENSUS_ADDRESS` at the wrong contract, and `EventIndexer`'s contract guard catches
  the case where an existing database was indexed against a different address.
- **Which sentinels exist** is *not* configuration and is never listed anywhere in this plan. It is
  derived entirely from indexed `Revealed` events, so sentinels being added to or removed from the
  oracle's allowlist mid-period is picked up automatically, with no operator action and no
  re-indexing.

This resolves [thread `r3924004224`](https://github.com/safe-fndn/safenet-staking-scripts/pull/68#discussion_r3924004224),
which questioned the configured *set* of oracles: with one canonical oracle there is no set to
disagree about, and no need for an on-chain registry of approved oracles to derive one from.

### Merkle DB accounting — the tokenTotal correction

`totalRewardsAmount()` in `src/utils/args.ts` derives the validator budget for a period as:

```ts
newTokenTotal = TOTAL_REWARDS * (paidRewardsDuration + periodDuration) / TOTAL_REWARDS_PERIOD
return newTokenTotal - index.tokenTotal;
```

`index.tokenTotal` is the cumulative sum of **all** distribution entries. Writing sentinel payouts
into the same distribution files therefore inflates `tokenTotal` and would silently *under-fund* the
validator program by exactly the accumulated sentinel spend. This must be fixed in the same epic:

- `IndexData` gains `sentinelTokenTotal: bigint`, parsed with `z.coerce.bigint().default(0n)` so
  existing `latest.json` records load unchanged.
- `MerkleDb.distribute()` takes an additional `sentinelTotal: bigint` argument and accumulates it
  into `index.sentinelTokenTotal` during `#rebuildTree`.
- `totalRewardsAmount()` uses `index.tokenTotal - index.sentinelTokenTotal` as the validator-paid
  total.

Sanctions filtering needs no change: `#rebuildTree` already excludes sanctioned accounts from the
tree for every distribution entry, so sentinels inherit it.

### CLI surface

`cmd:participation` prints **both** categories by default in one table, with a `Category` column
and a `--category validator|sentinel|all` flag (default `all`) to narrow it:

```
 Category  | Participant                                | Participation
-----------+--------------------------------------------+---------------
 Validator | 0x1234567890AbcdEF1234567890aBcdef12345678 |        98.00%
 Sentinel  | 0xBF508D62Aa45fA2Ac9173DD748E0005a6562E2dc |        85.23%
 Sentinel  | 0x85D31F85BFC175912bBf640a8A453f68B83A227f |        67.10%
```

Both queries are cheap, so there is no reason to make the operator ask twice to see the whole
picture. A single table with a category column — rather than two stacked tables — keeps TSV output
to one header row so it stays pipeable, and keeps the `--category` flag as a pure row filter rather
than a mode switch.

Implementation notes:

- `ParticipationItem` gains a `category` field, and a small `Category` column is added inline in
  `src/cmd/participation.ts` (a fixed-width `format` over a `"Validator" | "Sentinel"` union). It
  is not worth a shared helper in `src/utils/presentation.ts` until a second command needs it.
- Rows are grouped by category, then sorted by address within each group, so the output is stable.

The `--record` path is **not** extended: the
`safenet-beta-data` repository has no sentinel destination on `main` yet, and skipping the existing
self-contained `if (args.record !== undefined)` block is strictly less work than writing into it.
When it is added, the testnet
[`assets/sentinel-info.json`](https://github.com/safe-fndn/safenet-beta-data/blob/testnet/assets/sentinel-info.json)
already mirrors `validator-info.json`'s shape (`address`, `participation_rate_14d`, plus
`is_active` and `label`), so the existing writer generalises directly.

`cmd:rewards` prints sentinel payouts in the same table as validator payouts, with a third
`Sentinel Rewards` column under `--split`, and reports the forfeited total in the footer alongside
`Unpaid`:

```
 Recipient   | Stake Rewards | Commission | Sentinel Rewards | KYC
```

### Test cases

The data layer gets no unit tests of its own: neither `AttestationData` nor `StakingData` has any,
and both are covered entirely through the harness-driven integration tests below. The data-layer
cases worth covering are therefore folded into the participation integration test.

Integration (`tests/sentinel-participation.test.ts`, `tests/sentinel-rewards.test.ts`), built on
`createTestSafenet()`:

- three sentinels at 100 % / 80 % / 60 % over one period: the 60 % sentinel receives nothing while
  the other two receive the identical full `periodAmount`
- a sentinel exactly at the 70 % boundary is eligible
- a reveal landing in the period *after* its request still counts toward the request's period,
  mirroring `tests/block-times.test.ts`-style boundary coverage
- participation excludes requests created outside the period
- a `Revealed` whose `NewRequest` predates the oracle's configured start block is skipped without
  throwing, and does not appear in the numerator
- a period with zero requests yields no payouts and no divide-by-zero
- validator and sentinel payouts to the **same** address are summed into one distribution entry
- `sentinelTokenTotal` accounting: two consecutive periods of mixed payouts leave the validator
  budget from `totalRewardsAmount()` unchanged from the sentinel-free baseline

---

## Implementation Phases

### Phase 1 — ABI and data layer

**Files:** `src/abi.ts`, `src/data/sentinels.ts`
**Estimate:** ~190 LOC, 2 files

Adds `SENTINEL_ORACLE_ABI` and the `SentinelData` class (the four tables, prepared statements,
`registerOracle`, `registerRequest`, `registerReveal`, `participation`, `requestCount`). Nothing is
wired up yet, and there are no tests until the harness lands in Phase 3, so this PR is reviewable
purely as "is the schema and the participation query right?" — which is where the surrogate-key
design most needs scrutiny.

### Phase 2 — Indexer, `Safenet` wiring, configuration

**Depends on:** Phase 1
**Files:** `src/indexing/sentinels.ts`, `src/safenet.ts`, `src/utils/args.ts`,
`tests/harness/scenario.ts`, `.env.sample`, `README.md`
**Estimate:** ~110 LOC, 6 files

The `SentinelOracle` indexer (mapping the two events onto `SentinelData`), the required
`sentinelOracleAddress` / `sentinelOracleStartBlock` configuration, indexer construction in
`Safenet.create()`, and `Safenet.index()` including it. Documents the new environment variables in
`README.md`'s variable table and `.env.sample`. There are no new unit tests: the configuration is
the same plain zod address/block pair as every other contract, so there is nothing bespoke to test
until the harness lands in Phase 3.

Because the oracle address is required, `createTestSafenet()` has to pass one for the repo to
type-check, so this phase makes that one-line addition to `tests/harness/scenario.ts`; Phase 3 still
owns the event encoding and the rest of the harness plumbing. After this PR `cmd:index` indexes
sentinel events; nothing reads them yet.

### Phase 3 — Test harness support and `sentinelParticipation()`

**Depends on:** Phase 2
**Files:** `tests/harness/scenario.ts`, `tests/harness/utils.ts`, `tests/harness/presets.ts`,
`src/safenet.ts`, `tests/sentinel-participation.test.ts`
**Estimate:** ~230 LOC, 5 files

Extends `ConsensusChainEvent` with `NewRequest` / `Revealed` variants emitted from
`namedAddress("SentinelOracle")` (same chain as consensus), threads `sentinelOracleStartBlock`
through `createTestSafenet()`, adds a `sentinelRequest()` preset for the request-plus-reveals
sequence, implements `Safenet.sentinelParticipation()`, and covers it with the participation
integration test including the cross-period reveal case.

### Phase 4 — `cmd:participation` sentinel output

**Depends on:** Phase 3
**Files:** `src/cmd/participation.ts`, `README.md`
**Estimate:** ~40 LOC, 2 files

Adds the `Category` column, the sentinel rows, and the `--category validator|sentinel|all` filter,
reusing the existing `addressColumn` / `percentColumn` helpers unchanged. No `--record` changes and
no `src/utils/presentation.ts` changes. Kept separate from Phase 3 so the CLI change is reviewable
on its own.

### Phase 5 — Merkle DB sentinel-total accounting

**Parallelizable with:** Phases 3 and 4 (touches only `src/merkledb/`, `src/utils/args.ts`,
`src/cmd/rewards.ts`)
**Files:** `src/merkledb/index.ts`, `src/utils/args.ts`, `src/cmd/rewards.ts`,
`tests/merkledb-sentinel-total.test.ts`
**Estimate:** ~110 LOC, 4 files

Introduces `IndexData.sentinelTokenTotal` (defaulting to `0n`), the extra `sentinelTotal` argument
on `distribute()` (passed as `0n` by the existing caller), and the `totalRewardsAmount()`
correction, with a regression test proving the validator budget is unaffected by sentinel spend.
This is the one change that alters existing behaviour, so it is deliberately isolated.

### Phase 6 — `sentinelRewards()`

**Depends on:** Phase 3
**Files:** `src/safenet.ts`, `tests/sentinel-rewards.test.ts`
**Estimate:** ~120 LOC, 2 files

The reward calculation itself: duration proration against the 52-week constant, the 70 % threshold,
and the `forfeited` accounting, plus the `RewardSplit.sentinelRewards` field. Pure accounting logic
with no CLI or Merkle DB surface, which is the part that most deserves undivided reviewer attention.

### Phase 7 — `cmd:rewards` integration

**Depends on:** Phases 5 and 6
**Files:** `src/cmd/rewards.ts`, `src/utils/args.ts`, `README.md`, `.env.sample`
**Estimate:** ~120 LOC, 4 files

Merges validator and sentinel payouts into the single `distribute()` call, adds the third `--split`
column, the `--sentinelRewards` override and the `sentinelRewardsAmount()` helper, threads
`sentinelTotal` through, and documents the combined behaviour and the transaction bundle semantics.

### Phase 8 — Remove this specification

**Depends on:** Phase 7
**Files:** `epics/2026_09_02_sentinel_reward_calculation.md`
**Estimate:** deletion only

---

## Resolved Decisions

Recorded here because they shaped the plan above and are not obvious from the code:

1. **The aggregate cap is enforced by the oracle, not by this script.** Sentinels are allowlisted on
   the oracle contract, so the maximum sentinel count — and therefore the maximum annual spend — is
   known upstream. This script pays a fixed prorated grant per eligible sentinel and does not need
   its own pool cap. Maintaining a concrete sentinel list here may become necessary later; it is
   explicitly out of scope.
2. **Cross-period participation events are expected and fine.** Reveals may land in a different
   period than their request, exactly as `SignShared` may land in a different period than the
   `SignCompleted` that anchors a validator ceremony. No grace window, no boundary correction.
3. **Correctness is not this script's concern.** Any properly revealed vote counts as participation,
   whether or not it won the vote or was slashed in a dispute. Correct voting is rewarded through
   the oracle contract's fee logic.
4. **Failing to reveal is not participation**, so `Committed` is not indexed and liveness failures
   are not surfaced here — that belongs to separate monitoring tooling.
5. **Both programs are funded from the same treasury Safe**, so the transaction bundle keeps its
   single `transfer`.
6. **52 weeks is the proration unit**, matching the validator script's `26`-week convention in
   `src/utils/args.ts`.

---

## Pending Configuration, Deferred Work and Assumptions

There are **no open questions** — every question raised while drafting this plan has been answered
and recorded under [Resolved Decisions](#resolved-decisions). Nothing below blocks implementation:
the first group is values to fill in, the second is work intentionally left out of scope, and the
third is context a reviewer or implementer should know.

### Pending configuration values

Both are values plugged into the configuration described above, needed before the first production
run rather than before any code lands.

1. **The deployed oracle address and its start block** for `SENTINEL_ORACLE_ADDRESS` /
   `SENTINEL_ORACLE_START_BLOCK`. Both are required, so `.env.sample` ships a placeholder zero
   address and the consensus start block, marked `TODO`. These must be replaced with the real
   deployment before the first production run — until then sentinel participation indexes an empty
   contract and every sentinel rate is zero.
2. **Final `SENTINEL_REWARD_PER_YEAR`.** The plan uses 400 000 SAFE per the proposed DAO
   formulation; the figure may change when the proposal is finalised, which is a one-line constant
   change in `src/utils/args.ts` — the same as it would be for the validator `TOTAL_REWARDS`.

### Deferred to later epics

3. **Applying the 1 SAFE minimum to the merged validator + sentinel list.** The right end state, but
   it means lifting the filter out of `Safenet.rewards()`. Left to the rewards-refactoring epic
   rather than duplicated here.
4. **Writing sentinel participation into the record directory.** Waiting on a sentinel destination
   in `safenet-beta-data` on `main`; the testnet `sentinel-info.json` format is already compatible.
5. **Indexing `Committed`** to distinguish "committed but failed to reveal" from "never
   participated", if that ever becomes a rewards concern rather than a monitoring one.

### Assumptions

- The sentinel oracle is deployed on the consensus chain and reachable via `CONSENSUS_RPC_URL`.
- Sentinel addresses can claim from the cumulative Merkle drop directly; there is no sentinel-side
  beneficiary indirection analogous to the validator commission beneficiary (`SetDelegate`).
- There is exactly one canonical sentinel oracle contract, so participation has a single
  unambiguous denominator.
- Requests created before the oracle's configured `startBlock` are out of scope, and any reveals for
  them are excluded from both numerator and denominator.
- No historical seed data is required for the sentinel oracle; indexing starts from the configured
  start block.
- Because reveals are counted with no timestamp predicate (matching `signing_participants`), a
  period's sentinel rates can improve if the database is later indexed past `toTimestamp` and
  further reveals for late-period requests arrive. On the default `:memory:` database this cannot
  happen — `index(period)` stops at `toTimestamp` — and where it does happen it makes the rate more
  accurate rather than wrong. If bit-identical reproducibility across database states is ever
  required, adding a `reveals.block_timestamp < toTimestamp` bound would provide it at the cost of
  discarding exactly the cross-period reveals decision 2 above chose to keep.
