# Test Harness Plan

## Overview

The goal is an integration-style test harness that exercises the full `Safenet` class (rewards, participation, staking) using declarative mock chains — no real node, no dev chain. Tests specify a sequence of "slots" per chain, each either producing a block with events or being skipped (missed slot). The harness synthesizes mock viem `PublicClient` instances from this data and passes them straight into `Safenet.create`, so the real indexing and computation code runs unmodified.

---

## Directory Layout

```
tests/
  harness/
    chain.ts        # MockChain: builds block/log data from slot specs
    client.ts       # createMockClient: viem PublicClient backed by MockChain
    scenario.ts     # ScenarioSpec types + createTestSafenet factory
  rewards.test.ts   # Reward payout tests
  participation.test.ts
  ...
```

All harness code lives under `tests/harness/`. Test files sit directly in `tests/`.

---

## Core Concepts

### Slots

A *slot* is an entry in time. Each chain spec contains a flat array of slots. Every slot either:

- **`{ events?: Event[] }`** — a block was produced. Events listed here appear in that block.
- **`null`** — a missed slot. Time advances by one `blockTime`, but no block is produced and no block number is assigned.

Block numbers are auto-assigned sequentially (starting at 1) only to produced slots. Timestamps are derived from `genesisTime + slotIndex * blockTime`.

Example with `blockTime = 12s`, `genesisTime = T`:
```
slot 0 → block 1, timestamp T+0
slot 1 → null (missed), no block
slot 2 → block 2, timestamp T+24
slot 3 → block 3, timestamp T+36
```

This naturally supports chains with variable block times (just vary `blockTime`) and missed slots.

### MockChain (`tests/harness/chain.ts`)

Converts a `ChainSpec` into a data structure that serves the JSON-RPC calls:

```typescript
type ChainSpec<E> = {
  chainId: number;
  blockTime: bigint;       // seconds per slot
  genesisTime: bigint;     // unix timestamp of slot 0
  contractAddress: Address;
  slots: (Block<E> | null)[];
};

type Block<E> = {
  events?: E[];
};
```

Internally `MockChain` builds:
- `blocks: Map<bigint, { blockNumber: bigint; timestamp: bigint; logs: Log[] }>` keyed by block number
- `latestBlockNumber: bigint`

Logs are ABI-encoded using viem's `encodeEventTopics` / `encodeAbiParameters` so they are indistinguishable from real RPC responses. The `blockTimestamp` field on each log is populated so the `BlockTimestampCache` can harvest it without extra RPC calls.

### Mock Client (`tests/harness/client.ts`)

A standard viem `PublicClient` created via `createPublicClient` with a `custom` transport. The transport intercepts these JSON-RPC methods:

| Method | Behaviour |
|---|---|
| `eth_chainId` | Returns the configured `chainId` |
| `eth_blockNumber` | Returns `latestBlockNumber` |
| `eth_getBlockByNumber` | Looks up by number or returns latest block |
| `eth_getLogs` | Filters `blocks` by address + block range, returns matching logs |
| `eth_call` | Decodes call data; returns `coordinatorAddress` for `COORDINATOR()` |

This is the only surface that needs mocking — everything else in `Safenet` is pure computation over the indexed SQLite data.

```typescript
export function createMockClient(chain: MockChain, opts?: { coordinatorAddress?: Address }): PublicClient;
```

### Scenario & Factory (`tests/harness/scenario.ts`)

The `ScenarioSpec` type ties both chains together:

```typescript
type ScenarioSpec = {
  staking: ChainSpec<StakingEvent>;
  consensus: ChainSpec<ConsensusEvent> & {
    coordinatorAddress: Address;
  };
};
```

The factory function wires everything up:

```typescript
async function createTestSafenet(spec: ScenarioSpec): Promise<{
  safenet: Safenet;
}>;
```

Internally it:
1. Builds `MockChain` for the staking and consensus specs.
2. Creates mock viem clients (the consensus client returns `coordinatorAddress` for `eth_call`).
3. Calls `Safenet.create` with an in-memory SQLite database (`:memory:`) and a `blockPageSize` of `1n`.

Using `:memory:` means each test gets a clean database with no teardown.

---

## Event Types

Events are specified in a friendly, unencoded format. The harness encodes them into `Log` objects before serving them from the mock client.

### Staking chain events

```typescript
type StakingEvent =
  | {
      name: "ValidatorUpdated";
      validator: Address;
      isRegistered: boolean;
    }
  | {
      name: "StakeIncreased";
      staker: Address;
      validator: Address;
      amount: bigint;
    }
  | {
      name: "WithdrawalInitiated";
      staker: Address;
      validator: Address;
      withdrawalId: bigint;
      amount: bigint;
    };
```

### Consensus chain events

```typescript
type ConsensusEvent =
  | { name: "ValidatorStakerSet"; validator: Address; staker: Address }
  | {
      name: "TransactionProposed";
      transactionHash: Hex;
      chainId: bigint;
      safe: Address;
      epoch: bigint;
      transaction: MetaTx;
    }
  | {
      name: "TransactionAttested";
      transactionHash: Hex;
      epoch: bigint;
      attestation: Signature;
    }
  | { name: "KeyGen"; gid: Hex; count: number; threshold: number; context: Hex }
  | {
      name: "KeyGenCommitted";
      gid: Hex;
      identifier: bigint;
      participant: Address;
      commitment: KeyGenCommitment;
      committed: boolean;
    }
  | {
      name: "Sign";
      initiator: Address;
      gid: Hex;
      message: Hex;
      sid: Hex;
      sequence: bigint;
    }
  | { name: "SignRevealedNonces"; sid: Hex; identifier: bigint; nonces: Nonces }
  | {
      name: "SignShared";
      sid: Hex;
      selectionRoot: Hex;
      identifier: bigint;
      z: bigint;
    }
  | { name: "SignCompleted"; sid: Hex; selectionRoot: Hex; signature: Signature };
```

---

## Example Test

The following is a concrete test asserting on reward payouts. It uses a single validator with full participation over a 100-slot period.

```typescript
// tests/rewards.test.ts
import { describe, expect, it } from "vitest";
import { parseUnits } from "viem";
import { createTestSafenet } from "./harness/scenario.js";

const GENESIS    = 1_700_000_000n;  // arbitrary start time
const BLOCK_TIME = 12n;             // 12 second slots

const STAKING_CONTRACT     = "0x1000000000000000000000000000000000000001";
const CONSENSUS_CONTRACT   = "0x2000000000000000000000000000000000000002";
const COORDINATOR_CONTRACT = "0x3000000000000000000000000000000000000003";

const VALIDATOR = "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const STAKER    = "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";

const GID = "0x0000000000000000000000000000000000000000000000000000000000000001";
const SID = "0x0000000000000000000000000000000000000000000000000000000000000002";
const SELECTION_ROOT = "0x000000000000000000000000000000000000000000000000000000000000000f";

// A minimal valid meta-transaction (non-zero `to` passes the check).
const META_TX = {
  chainId: 1n,
  safe: STAKER,
  to: "0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC",
  value: 0n,
  operation: 0,
  data: "0x",
  safeTxGas: 0n,
  baseGas: 0n,
  gasPrice: 0n,
  gasToken: "0x0000000000000000000000000000000000000000",
  refundReceiver: "0x0000000000000000000000000000000000000000",
  nonce: 1n,
};

// Dummy signature (non-zero to satisfy any bigint arithmetic).
const SIGNATURE = { r: { x: 1n, y: 2n }, z: 3n };

const TX_HASH = "0x00000000000000000000000000000000000000000000000000000000000000aa";

describe("rewards", () => {
  it("distributes all rewards to the staker when a single validator has full participation", async () => {
    const TOTAL_SLOTS = 100;

    const { safenet } = await createTestSafenet({
      staking: {
        chainId: 1,
        blockTime: BLOCK_TIME,
        genesisTime: GENESIS,
        contractAddress: STAKING_CONTRACT,
        slots: [
          // Slot 0 — block 1: validator registers and staker stakes.
          {
            events: [
              {
                name: "ValidatorUpdated",
                validator: VALIDATOR,
                isRegistered: true,
              },
              {
                name: "StakeIncreased",
                staker: STAKER,
                validator: VALIDATOR,
                amount: parseUnits("5000000", 18), // 5M SAFE (above 3.5M minimum)
              },
            ],
          },
          // Slots 1-99: no staking activity.
          ...Array<null>(TOTAL_SLOTS - 1).fill(null),
        ],
      },
      consensus: {
        chainId: 100,
        blockTime: BLOCK_TIME,
        genesisTime: GENESIS,
        contractAddress: CONSENSUS_CONTRACT,
        coordinatorAddress: COORDINATOR_CONTRACT,
        slots: [
          // Slot 0 — block 1: set up the validator staker and signing group.
          {
            events: [
              { name: "ValidatorStakerSet", validator: VALIDATOR, staker: STAKER },
              {
                name: "KeyGen",
                gid: GID,
                count: 1,
                threshold: 1,
                context: "0x0000000000000000000000000000000000000000000000000000000000000000",
              },
              {
                name: "KeyGenCommitted",
                gid: GID,
                identifier: 1n,
                participant: VALIDATOR,
                commitment: {
                  q: { x: 1n, y: 2n },
                  c: [],
                  r: { x: 3n, y: 4n },
                  mu: 5n,
                },
                committed: true,
              },
            ],
          },
          // Slots 1-49: one signing ceremony per slot (50 total packets).
          ...Array.from({ length: 49 }, (_, i) => {
            const sid  = `0x${(i + 1).toString(16).padStart(64, "0")}` as `0x${string}`;
            const msg  = `0x${(i + 100).toString(16).padStart(64, "0")}` as `0x${string}`;
            const txh  = `0x${(i + 200).toString(16).padStart(64, "0")}` as `0x${string}`;
            return {
              events: [
                { name: "Sign" as const, initiator: VALIDATOR, gid: GID, message: msg, sid, sequence: BigInt(i + 1) },
                { name: "SignRevealedNonces" as const, sid, identifier: 1n, nonces: { d: { x: 1n, y: 2n }, e: { x: 3n, y: 4n } } },
                { name: "SignShared" as const, sid, selectionRoot: SELECTION_ROOT, identifier: 1n, z: 1n },
                { name: "SignCompleted" as const, sid, selectionRoot: SELECTION_ROOT, signature: SIGNATURE },
                {
                  name: "TransactionProposed" as const,
                  transactionHash: txh,
                  chainId: 1n,
                  safe: STAKER,
                  epoch: BigInt(i + 1),
                  transaction: { ...META_TX, nonce: BigInt(i + 1) },
                },
                { name: "TransactionAttested" as const, transactionHash: txh, epoch: BigInt(i + 1), attestation: SIGNATURE },
              ],
            };
          }),
          // Slots 50-99: no consensus activity.
          ...Array<null>(TOTAL_SLOTS - 50).fill(null),
        ],
      },
    });

    const period = {
      fromTimestamp: GENESIS,
      toTimestamp: GENESIS + BLOCK_TIME * BigInt(TOTAL_SLOTS),
    };
    const totalRewards = parseUnits("100000", 18); // 100,000 SAFE

    const { payouts, unpaid } = await safenet.rewards(period, totalRewards);

    // With 100% participation and one staker owning all stake, every reward
    // (minus the sub-1-SAFE rounding residue) goes to STAKER.
    expect(Object.keys(payouts)).toEqual([STAKER]);
    expect(unpaid).toBeLessThan(parseUnits("1", 18));
    expect(payouts[STAKER] + unpaid).toEqual(totalRewards);
  });
});
```

---

## Implementation Notes

1. **Log encoding** — Use viem's `encodeEventTopics` (for indexed fields) and `encodeAbiParameters` (for non-indexed fields) to produce correctly-formed `eth_getLogs` responses. The `blockTimestamp` field on each `Log` should be set so `BlockTimestampCache.recordLog` can harvest it, avoiding extra `eth_getBlockByNumber` calls during indexing.

2. **`eth_call` decoding** — `readContract` sends ABI-encoded calldata. For the single `COORDINATOR()` call the harness only needs to handle the specific selector (`0x...`) and return the ABI-encoded coordinator address.

3. **`blockPageSize: 1n`** — Setting this to `1n` ensures the indexer fetches one block per `getLogs` page, which keeps the mock simple (no need to batch merge).

4. **In-memory SQLite** — Pass `":memory:"` as the database file to `Safenet.create`. Each `it()` block gets a fresh database with no teardown.

5. **Chain independence** — The staking and consensus chain specs are completely independent. They can have different chain IDs, block times, genesis times, and total slot counts. This lets tests simulate realistic multi-chain scenarios.

6. **Determinism** — Because all block data is derived from the spec (no real network, no timing), tests are fully deterministic and can run in CI without any external dependencies.

---

## Open Questions / Items to Confirm Before Coding

- [ ] Should missed slots advance the block number (leaving a gap) or only advance time without consuming a block number? The current plan assigns block numbers only to produced slots (no gaps), which is simpler but differs from real PoS chains. Confirm the desired behaviour.
- [ ] Do we need a vitest config change (`vitest.config.ts`) to pick up tests in `tests/` in addition to `src/`? Confirm current glob settings.
- [ ] Is there any existing test infrastructure (fixtures, helpers) in `src/` we should reuse or unify with?
