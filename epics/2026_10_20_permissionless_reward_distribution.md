# Plan: Permissionless Reward Distribution

Component: `@safenet/accounting` (this repository: `src/`, `data/`, `.github/workflows/`, `README.md`).

---

## Overview

Today an SEF operator produces each reward distribution by running `cmd:rewards --record` locally, and an SEF Safe executes the resulting Safe transaction bundle. This epic adds the tooling for **anyone** to reproduce a distribution byte-for-byte, publish it, and take it through the Reality.eth → Zodiac Reality Module → Safenet Governance Safe flow. That flow is deployed by _Configure Safenet Governance Safe - Mainnet_, called "the governance setup" below.

All inputs are either onchain or versioned in this repository:

- **Onchain:** `rewards.safenet-gov.eth` already points to the latest rewards DB, and the Cumulative Merkle Drop holds its root. Each distribution starts from the rewards DB that the ENS `contenthash` pins, and when its proposal executes, the Governance Safe moves both pointers to the new rewards DB.
- **In this repository:** the KYC threshold and the KYC-approved accounts, in `data/kyc.json`. They therefore stay in sync with the code that produces the reproducible bundles, without relying on any external mechanism to communicate them.

The deliverables map onto the phases as follows:

| Deliverable | Phases |
| --- | --- |
| Deterministic export and independent verification | 1–9, 12, 14–17 |
| Deterministic transaction-bundle generation | 11, 13 |
| IPFS bundle and release publication | 10, 19 |
| Daily indexing and cadence-aligned distribution runs | 18, 19 |
| Sanctions screening (already done in #79) | 9 (pinning) |
| Operator documentation for the permissionless flow | 20 |

The work breaks down into:

1. **Drop `updatedAt` from the Merkle DB index.** The pinned rewards DB no longer has it, and the current schema requires it.
2. **Allow the Beta → Aegis gap.** A one-off exception to the contiguous-period check for the week between the two programs.
3. **Move transaction bundles out of the rewards directory.** The rewards DB no longer contains `transactions/`.
4. **Root `MerkleDb` at a rewards directory** (refactor). The rewards DB is now a standalone IPFS directory.
5. **Block-at-timestamp lookup.** Find the consensus block that a period's settlement is measured from, plus the per-chain boundary blocks recorded in the manifest.
6. **Settlement window for sentinel reveals** and
7. **Settlement window for transaction attestations.** Make every reward query a pure function of chain history up to a fixed settlement point (48 consensus blocks after the period ends), so the result no longer depends on how far a database happens to be indexed.
8. **KYC file.** Add `data/kyc.json`, holding the KYC threshold and the KYC-approved accounts. SEF edits it manually, and it is seeded with the end-of-Beta threshold and approvals.
9. **Pinned sanctions snapshots.** Use the dated `data-YYYY-MM-DD` releases of `sanctions-address-lists` instead of the moving `latest` release.
10. **IPFS packing.** Deterministic UnixFS/CAR packing and verified unpacking, in pure JS.
11. **Governance Safe transactions.** The three calls the Governance Safe executes, their Zodiac transaction hashes, and the Reality.eth question ID.
12. **Previous rewards DB resolution.** ENS `contenthash` → CID → verified CAR → directory, cross-checked against the onchain Merkle root.
13. **Action bundles.** Safe Transaction Builder JSON files for proposing, answering **Yes** and executing.
14. **Package manifest and assembly.**
15. **`cmd:export`.**
16. **`cmd:verify`** (offline, byte-for-byte).
17. **Onchain consistency checks.**
18. **Daily indexing Action.**
19. **Distribution Action.**
20. **Operator runbook.**
21. **Cleanup.** Remove this specification file.

Phases 1, 2, 3, 5, 8, 9, 10 and 18 are independent of each other and can be developed in parallel. Phase 1 fixes a parse failure against the currently pinned rewards DB and should land first. See [Implementation Phases](#implementation-phases) for the full dependency graph.

**Out of scope:**

- CLI commands that _send_ the propose, answer/challenge and execute transactions, or that inspect proposal and bond state (struck from the deliverables). Instead, every release ships Safe Transaction Builder bundles for the three actions. Any Safe can load them, an EOA can decode them, and the runbook covers challenges and timing checks.
- **IPFS pinning.** The epic produces the CAR and CID and mirrors them as release assets. Pinning is a separate community action, and CC is expected to pin.
- The Safe, oracle, modules, question template, ENS name, funding and ownership transfers come from the governance setup.
- The reward methodology itself comes from the separate _Update validator rewards scripts_ task, except for the Aegis validator budget constants, which Phase 2a sets. Sentinel rewards are already implemented (`Safenet.sentinelRewards`). See [Program parameters](#program-parameters).
- **Database migrations.** Aegis changed the database schema, and indexing restarts from a new database at the Aegis consensus deployment block.

---

## Architecture Decision

### A distribution is a function of (pinned rewards DB, chain history, versioned inputs)

Distributions are **cumulative**: every rewards DB contains the full proof set for every account, and rewards DB _N_ is derived from rewards DB _N − 1_ plus the chain history of period _N_. The existing `MerkleDb` already does exactly this over a directory. The export command reuses it unchanged, against a temporary copy of the previous rewards DB, then lays out the result as the new package. No new accounting code is written.

```
ENS contenthash ─► CID ─► verified CAR ─► previous rewards DB ─┐
chain history ≤ settlement ────────────────────────────────────┼──► Safenet.rewards + sentinelRewards ──► MerkleDb.distribute ──► package dir
data/kyc.json (@ generator commit) ────────────────────────────┤                                                                 │
sanctions (data-YYYY-MM-DD) ───────────────────────────────────┘                                         IPFS pack (fixed params) ◄┘
                                                                                                                      │
                                                                                                CID = proposalId = next ENS contenthash
                                                                                                                      │
                                                                                      Governance Safe transactions + action bundles
```

The previous rewards DB is never chosen by the operator. The export reads the `contenthash` of `rewards.safenet-gov.eth` and fetches that CID, verifying every block against it. It then requires the fetched `latest.json` Merkle root to equal `CumulativeMerkleDrop.merkleRoot()`. The two canonical references must agree. If they don't (for example, between the `setMerkleRoot` and `setContenthash` executions of a proposal), the export refuses to run. So the chain of rewards DBs always extends the DAO-controlled state.

Today the ENS record points to `bafybeiczeo7uiupwte7dfa3yaus6dogwauxbookpvcgmxebbga5jtp7afq`, and its `latest.json` root is `0x6689…fdef`, matching the drop. That rewards DB has no manifest, so the package reader accepts a previous rewards DB without one.

### Settlement window: 48 consensus blocks

Period accounting is keyed on events _inside_ `[fromTimestamp, toTimestamp]`. However, two kinds of event that complete a period's unit of work can land _after_ `toTimestamp`, and today they are counted with no bound at all:

- **Sentinel reveals** are joined onto their request with no condition on the reveal itself (`sentinel_reveals` has no timestamp).
- **`TransactionAttested`** only sets `signing_ceremonies.is_transaction_attestation`. It is also indexed by a different indexer (`Transactions`) from the `SignCompleted` event that ties the ceremony to a period.

The result therefore depends on how far past `toTimestamp` the database was indexed. A `:memory:` run stops at the first page past `toTimestamp`, so its result also depends on `CONSENSUS_BLOCK_PAGE_SIZE`. The persistent daily snapshot is indexed up to "now". As long as this is true, byte-for-byte reproducibility is impossible.

We define a hard-coded `SETTLEMENT_BLOCKS = 48` on the consensus chain:

```
boundaryBlock       = last consensus block with timestamp ≤ toTimestamp
settlementBlock     = boundaryBlock + 48
settlementTimestamp = timestamp(settlementBlock)
```

Late-arriving events count **only if** `block_timestamp ≤ settlementTimestamp`. Block timestamps strictly increase on Gnosis Chain, so this condition is equivalent to `block_number ≤ settlementBlock`, and the tables don't need block numbers. `Safenet` indexes the consensus chain up to `settlementTimestamp` before computing participation, and fails while the settlement block does not exist yet. That wait is about 4 minutes, which is negligible for the distribution Action.

The value 48 comes from the `transaction_attestation_duration` default in `safenet-monitor` (`src/main.rs`, introduced in ad1bb87): _"Worst case for an oracle approved transaction with the default Aegis validator configuration: 24 blocks of oracle timeout, followed by 6 blocks each for nonce commitments, signature shares and the fallback attestation, with some extra margin for transaction inclusion."_ It covers both late events. A sentinel reveal later than the 24-block oracle timeout no longer affects the outcome, and an attestation later than 48 blocks is one the monitor already records as missed.

The cutoff applies to the whole period, not to each item. Every request and ceremony in the period starts at or before `boundaryBlock`, so `boundaryBlock + 48` covers the worst case for all of them. Items earlier in the period keep the existing "no bound" semantics in practice. The sentinel epic's decision that a reveal landing after the period boundary still counts is preserved.

Two "late" facts need a timestamp: `sentinel_reveals.block_timestamp`, and `signing_ceremonies.attested_block_timestamp`. The second is one integer per ceremony, not per participant, so it stays within the schema conventions. Both are plain table-definition changes. No migration code is written, because Aegis indexing starts from a new database.

### Terminology: the rewards bundle, the transactions and the release

"Bundle" means two different things in this flow, so this plan keeps them apart:

- **The rewards bundle** (the "rewards DB", or "the package" in the rest of this plan) is the IPFS bundle of the Merkle DB contents after the distribution, plus the manifest and allocations. It is a UnixFS directory whose root is the **CID**, and it contains `manifest.json`, `allocations.json`, `latest.json` and the full cumulative `proofs/` tree, including the Merkle root. It holds everything needed to verify and to claim. It is mirrored as a CAR file in the GitHub release and pinned by CC or anyone else.
- **The transaction bundles** are the Governance Safe transactions that the Zodiac proposal executes, and the three Safe Transaction Builder bundles for proposing, answering and executing. They are _about_ the rewards bundle: each one references its CID and Merkle root. They are never written into the rewards directory.
- **The release** is the GitHub Release that carries both, plus the CID, the Merkle root and checksums.

One CID is used in three places. It is the IPFS root of the rewards bundle. It is the Zodiac `proposalId`, so the Reality.eth question is about that dataset. And the Governance Safe writes it into the `contenthash` of `rewards.safenet-gov.eth` when the proposal executes, so the ENS record keeps pointing to the latest rewards DB, alongside the onchain Merkle root. The transaction bundles contain the CID (in `setContenthash`, `addProposal` and so on), so they must stay outside the rewards bundle. They are deterministic functions of the CID, the Merkle root, the funding amount and the onchain governance configuration, and `cmd:verify` re-derives them.

### Governance Safe transactions, executed one by one

Zodiac executes proposal transactions one at a time (`executeProposalWithIndex`), and transaction _i_ can only execute after _i − 1_ has. The list is ordered so that every intermediate state is safe:

1. `SAFE.transfer(cumulativeMerkleDrop, additionalAmount)`. Funding comes first, so the drop always holds enough tokens for its root.
2. `CumulativeMerkleDrop.setMerkleRoot(root)`.
3. `PublicResolver.setContenthash(namehash("rewards.safenet-gov.eth"), 0xe301 ‖ CID)` (ENSIP-7).

Transactions are encoded as raw `data` with `operation = 0`, because the Zodiac transaction hash commits to the exact calldata.

### Action bundles instead of send-transaction tooling

Each release contains three Safe Transaction Builder bundles that **any** Safe can execute:

| Bundle | Transactions |
| --- | --- |
| `propose.json` | `RealityModule.addProposal(CID, txHashes)` |
| `answer.json` | `SAFE.approve(oracle, minimumBond)`, `oracle.submitAnswerERC20(questionId, bytes32(1), 0, minimumBond)` |
| `execute.json` | `RealityModule.executeProposalWithIndex(CID, txHashes, to, value, data, 0, i)` for `i = 0, 1, 2` |

- `answer.json` posts the initial **Yes** answer with the module's minimum bond. `max_previous = 0` makes it revert if anyone has already answered, rather than silently escalating. Challenges and counter-answers depend on live bond state, so the runbook covers them (at least double the current bond, and the timeout restarts).
- `execute.json` batches all three executions. The Transaction Builder runs them as one MultiSend from the executor's Safe, so the Governance Safe's state changes atomically from the executor's point of view.
- `questionId` is computed locally with nonce `0`, the same way the module derives it. The inputs are the template ID, opening time `0`, question text `CID ␟ txHashes`, arbitrator, timeout, minimum bond, oracle and module. The value is checked against the module's `getQuestionId` view. The bundle is only valid for the first time the question is asked. If a proposal is marked invalid and re-asked, nonce `0` no longer applies and the runbook explains how to proceed.

### Configuration comes from the module, not from env

Only the module address, the ENS name and the IPFS gateway are configuration. Everything else the governance setup records is read back from chain at export time, recorded in the manifest, and re-read by `cmd:verify`:

| Value | Source |
| --- | --- |
| Governance Safe | `module.avatar()` (and `target()`) |
| Reality.eth oracle | `module.oracle()` |
| Template, arbitrator, minimum bond | `module.template()`, `arbitrator()`, `minimumBond()` |
| Timeout, cooldown, expiration | `module.questionTimeout()`, `questionCooldown()`, `answerExpiration()` |
| Bond token | `oracle.token()` |
| ENS resolver, previous rewards DB | ENS registry `resolver(namehash(name))`, resolver `contenthash(node)` |

This follows "consume the verified active configuration" literally: if the governance setup changes the bond or the template, the next export picks it up and the manifest shows the change.

### KYC threshold and approvals are versioned with the code

KYC has two inputs:

- **The threshold:** the payout amount at or above which a recipient's payout is withheld in `kycAmount` until they are approved.
- **The approvals:** the `"kyc": true` field on an account's entry in `proofs/`, next to `cumulativeAmount` and `kycAmount`.

Both come from `data/kyc.json` in this repository, which SEF edits manually through reviewed PRs (the repository is in the SEF org). The export uses the file's threshold for `distribute`, and applies the flag to every listed account before it, so any withheld `kycAmount` is released in the same tree rebuild as the period's payouts. Because the file is versioned alongside the code that produces the bundle, `generator.commit` pins it. There is no flag, workflow input or external lookup for either value, and `cmd:verify` sees the same file simply by checking out that commit.

Flags are sticky: removing an address from the file does not revoke an approval. The export refuses to run if any account flagged in the previous rewards DB is missing from `data/kyc.json`, so the file is always the complete list. To help answerers, the manifest records `kyc.newlyApproved`, the listed accounts that were not yet flagged in the previous rewards DB.

### Deterministic IPFS in JavaScript

The CID is computed in-process with `ipfs-unixfs-importer` and written as a CARv1 with `@ipld/car`, so a verifier needs nothing beyond `npm ci`. The import parameters are fixed constants and recorded in the manifest: CIDv1 base32, `sha2-256`, raw leaves, fixed-size 256 KiB chunker, balanced layout, no directory sharding, no `mtime`/`mode` metadata, no wrapping directory. These are Kubo's `ipfs add -r --cid-version=1` defaults. The currently pinned rewards DB was produced that way: its `latest.json` is a raw leaf whose hash equals the file's SHA-256. As a self-check, the export re-packs the unpacked previous rewards DB and warns if the CID differs.

Fetching uses an IPFS trustless gateway (`?format=car`), configurable through `IPFS_GATEWAY_URL` and defaulting to a local node's gateway (`http://127.0.0.1:8080`, as served by Kubo). A CAR is verified block by block against the requested CID, so the gateway, a release asset or a local file can each be the source, and none of them needs to be trusted.

### Canonical JSON matches the pinned rewards DB

The currently pinned rewards DB uses tab indentation, recursively sorted keys and a trailing newline (`jq --tab --sort-keys`). Package files and `data/kyc.json` use the same canonical form, with `bigint`s as decimal strings. Address arrays (`data/kyc.json` `accounts`, `allocations.json`, `manifest.kyc.newlyApproved`) are sorted by the 20 address bytes, which is the same as a case-insensitive sort of the hex string. That is what the existing `sortByAddress` in `src/utils/sort.ts` already does, and it is the order the Merkle tree leaves already use.

### Release assets, not git, for data availability

Packages and index snapshots are published as **GitHub Release assets** of this repository. These are explicitly non-canonical mirrors, and the release notes say so. The canonical references remain the onchain Merkle root and the ENS `contenthash` set by the Governance Safe.

### Alternatives Considered

- **Cut late events off at `toTimestamp`** instead of using a settlement window. This is simpler, but it silently drops the reveals and attestations that straddle the boundary, which reverses a decision of the sentinel rewards epic. Rejected.
- **Per-item deadlines** (request or proposal block + 48). More precise, but they need a block number on every row and change the semantics for items well inside the period. Rejected in favour of one cutoff per period.
- **A settlement window in seconds** (e.g. 48 × 5 s). Gnosis block times are not exact, so it would drift from the block-based reasoning above. Rejected.
- **Require verifiers to index exactly to recorded boundary blocks.** This only works with a fresh database, while the daily snapshot is indexed past the boundary. The boundary and settlement blocks are still recorded for auditability. Rejected as the mechanism.
- **Let the operator pick the previous rewards DB** (a `--previous` path, or the newest matching release). This adds a trust decision that the ENS record already makes, and lets an export silently build on the wrong state. It is kept only as a local _source_ for the CID the ENS record names, never as a choice of which CID. Rejected.
- **KYC threshold and approvals as CLI or workflow inputs** (today's `--kycThreshold`). These would have to be recorded in the manifest and supplied again to every verifier, and nothing would keep them in sync with the code. Rejected in favour of `data/kyc.json`.
- **Compute the CID with the Kubo CLI.** This adds a non-npm toolchain to every verifier, and the output would depend on the Kubo version. Kept only as a cross-check in a test. Rejected.
- **One `MultiSendCallOnly` delegatecall as the single proposal transaction.** Atomic, but it needs a module delegatecall on the Governance Safe and hides the individual calls from answerers. The executor-side batching in `execute.json` gets most of the benefit. Rejected.
- **Raw calldata files for propose/answer/execute.** Replaced by Transaction Builder bundles, which any Safe can load directly.
- **Persist the SQLite index with `actions/cache`.** Caches are evicted after 7 days, are scoped to a branch, and cannot be downloaded publicly. Rejected in favour of release assets.
- **Re-index from genesis in every verification.** Too slow and RPC-expensive for every run. Offered as an opt-in `workflow_dispatch` input of the distribution Action instead.

---

## User Flow

None of these users needs SEF approval or write access to the repository. The one exception is the KYC process, in which SEF edits the threshold and approvals in `data/kyc.json`.

### Automated publisher (GitHub Actions)

```
daily     restore index snapshot ─► cmd:index ─► cmd:index --validate ─► rotate snapshot assets
cadence   restore snapshot ─► cmd:index ─► cmd:export ─┬─► (fresh runner) cmd:verify ─► gh release create rewards-<toTimestamp>
                                                       └─► release-asset artifact ──────┘
```

### Independent verifier

```sh
gh release download rewards-1793404800 -R safe-fndn/safenet-staking-scripts -D ./rel
git checkout "$(jq -r .generator.commit ./rel/manifest.json)" && npm ci
npm run cmd:verify -- --package ./rel/rewards-1793404800.car
```

```
Previous CID:       bafybeiczeo7… (rewards.safenet-gov.eth, root 0x6689… == merkleRoot())
Package CID:        bafybei…
Merkle root:        0x3f1c…  (matches)
Files:              412 / 412 identical
New KYC approvals:  0
Transactions:       3 / 3 identical, Zodiac hashes match module
Question ID:        0x8e2a…  (matches module.getQuestionId)
Action bundles:     propose, answer, execute identical
Safe SAFE balance:  1,234,567.89 ≥ 172,603.12 required
OK
```

Any mismatch prints a per-file diff and exits non-zero.

### Proposer, answerer, executor (documented, no new tooling)

1. _Optional, anyone, outside this epic:_ pin the CAR (`ipfs dag import rewards-<t>.car`).
2. Load `propose.json` into the Transaction Builder of any Safe and execute it. This costs gas and any question fee, but no bond.
3. Load `answer.json` and execute it to answer **Yes** with the minimum bond. A challenger answers with at least twice the current bond, following the runbook.
4. Once the answer is final, the cooldown has elapsed and the answer has not expired yet, load `execute.json` and execute it.
5. Run `cmd:verify --postExecution` to confirm that the onchain root and the ENS `contenthash` now point to the package.

### Page Layout

No pages are added; the CLI output above is the only interface.

---

## Tech Specs

### Program parameters

This epic does not change the reward methodology. It packages whatever the reward scripts compute. For reference, the Safenet Aegis proposal that the methodology tasks implement:

- **Validators:** ~5,000,000 SAFE over 12 months starting **Tuesday 2026-10-13**, distributed **every 2 weeks**. This matches the existing Tuesday-to-Tuesday `rewardsPeriod()` grid (2026-04-07 + 27 weeks).
- **Sentinels:** ~2,400,000 SAFE as grants to 6 genesis Sentinels (400,000 SAFE each per year). As the DAO proposal allows, the sentinel rewards period is collapsed into the two-week rewards period. Sentinel rewards are computed and distributed on the **same two-week period** as validator rewards, prorated by the period's duration (`sentinelRewardsAmount`).

There is therefore a single rewards period. Both programs are computed over the same `[fromTimestamp, toTimestamp]` and merged into one distribution, so the manifest has one `period` and every command takes one `--rewardPeriodStart`/`--rewardPeriodEnd` pair. This is how `cmd:rewards` already works.

**The Beta → Aegis gap.** The pinned rewards DB ends at `rewardsUntil = 2026-10-06`, and Aegis starts on 2026-10-13. `MerkleDb.distribute` rejects periods that are not contiguous, so it gets one hard-coded exception. It accepts `fromTimestamp = 2026-10-13` when `rewardsUntil = 2026-10-06`, and no other gap. No rewards are paid for the week in between.

### Package layout (the CID root)

```
manifest.json
allocations.json
latest.json
proofs/<b0>/<b1>/<b2>/<b3>/<0xaddress>.json   # unchanged MerkleDb layout, cumulative
```

`latest.json` and `proofs/` keep exactly the layout of the currently pinned rewards DB. `latest.json` has no `updatedAt` (Phase 1), and there is no `transactions/` directory (Phase 3). `manifest.json` and `allocations.json` are new, and consumers that only read `latest.json` and `proofs/` are unaffected.

### Release assets (outside the CID)

| Asset | Contents |
| --- | --- |
| `rewards-<t>.car` | CARv1 of the package, root = package CID |
| `cid.txt` | Package CID (CIDv1 base32) |
| `merkle-root.txt` | Merkle root |
| `proposal.json` | `proposalId`, `questionId`, and the 3 Governance Safe transactions (`to`, `value`, `data`, `operation`, Zodiac `hash`) |
| `propose.json` | Transaction Builder bundle: `addProposal` |
| `answer.json` | Transaction Builder bundle: `approve` + `submitAnswerERC20` (Yes) |
| `execute.json` | Transaction Builder bundle: 3 × `executeProposalWithIndex` |
| `manifest.json` | Copy of the package manifest, for convenience |
| `SHA256SUMS` | Checksums of all of the above |

Transaction Builder bundles use `chainId: "1"`, `createdAt: settlementTimestamp × 1000`, raw `data`, and no `createdFromSafeAddress`, because any Safe may load them.

Zodiac transaction hashes use EIP-712 with domain `EIP712Domain(uint256 chainId,address verifyingContract)` = `{ 1, module }` and struct `Transaction(address to,uint256 value,bytes data,uint8 operation,uint256 nonce)`, where `nonce` is the transaction index. They are computed locally with viem's `hashTypedData` and cross-checked against `module.getTransactionHash`.

### Manifest (`src/distribution/manifest.ts`, zod schema)

```jsonc
{
  "allocations": { "forfeited": "…", "unpaid": "…" },
  "chains": {
    "consensus": {
      "boundaryBlock": "…",
      "chainId": 100,
      "contracts": { "consensus": "0x…", "sentinelOracle": "0x…" },
      "settlementBlock": "…",
    },
    "staking": {
      "boundaryBlock": "…",
      "chainId": 1,
      "contracts": {
        "delegateRegistry": "0x…",
        "sanctionsList": "0x…",
        "staking": "0x…",
      },
    },
  },
  "distribution": {
    "additionalAmount": "…",
    "cumulativeMerkleDrop": "0x…",
    "merkleRoot": "0x…",
    "safeToken": "0x…",
    "tokenTotal": "…",
  },
  "generator": {
    "commit": "<sha>",
    "repository": "https://github.com/safe-fndn/safenet-staking-scripts",
  },
  "governance": {
    "answerExpiration": "…",
    "arbitrator": "0x…",
    "avatar": "0x…",
    "bondToken": "0x…",
    "ensName": "rewards.safenet-gov.eth",
    "ensResolver": "0x…",
    "minimumBond": "…",
    "module": "0x…",
    "oracle": "0x…",
    "questionCooldown": "…",
    "questionTimeout": "…",
    "templateId": "…",
  },
  "ipfs": {
    "car": 1,
    "chunker": "size-262144",
    "cidVersion": 1,
    "hash": "sha2-256",
    "layout": "balanced",
    "rawLeaves": true,
  },
  "kyc": { "newlyApproved": ["0x…"], "threshold": "…" },
  "parameters": {
    "minPayout": "…",
    "sentinelRewards": "…",
    "totalRewards": "…",
  },
  "period": {
    "fromTimestamp": "…",
    "settlementTimestamp": "…",
    "toTimestamp": "…",
  },
  "previous": { "cid": "bafy…", "merkleRoot": "0x…", "rewardsUntil": "…" },
  "sanctions": {
    "offchain": {
      "release": "data-2026-10-26",
      "repository": "safe-fndn/sanctions-address-lists",
      "sha256": {
        "ch-seco": "…",
        "eu": "…",
        "uk": "…",
        "un": "…",
        "us-ofac": "…",
      },
    },
  },
  "version": 1,
}
```

- `generator.commit` comes from `GIT_COMMIT` when set (Docker, Actions) and from `git rev-parse HEAD` otherwise. Export refuses to run on a dirty tree. `cmd:verify` warns when `HEAD` differs from the recorded commit, because matching bytes (including `data/kyc.json`) are only guaranteed for the same commit and lockfile.
- `previous` is the ENS-pinned rewards DB the package was built on. `cmd:verify` re-derives from exactly this CID. Before execution it also checks that the CID is still what the ENS record names, and after execution that it is the predecessor.
- `parameters` records the effective values, whether defaulted or overridden. `cmd:verify` calls out any override explicitly. `kyc.threshold` is copied from `data/kyc.json` for readability; it cannot be overridden.

### `allocations.json`

This period's payout per recipient, sorted by address bytes (`sortByAddress`):

```jsonc
[
  {
    "account": "0x…",
    "commission": "…",
    "sentinelRewards": "…",
    "stakeRewards": "…",
    "status": "paid" | "kyc-withheld" | "sanctioned",
  },
]
```

### `data/kyc.json`

A canonical JSON object:

```jsonc
{
  "accounts": ["0x…"], // checksummed, sorted by address bytes, no duplicates
  "threshold": "…", // whole SAFE, parsed with parseUnits(…, 18) like today's --kycThreshold
}
```

It is parsed with a zod schema that rejects duplicates, unsorted accounts and malformed amounts, so tests catch a broken manual edit. The file is seeded as follows:

- `threshold` is `"7500"` SAFE: below 1,000 USDC, with some buffer for price movement.
- `accounts` are the 13 accounts flagged `"kyc": true` in the rewards DB pinned at the end of Beta (`bafybeiczeo7…`):

```
0x0484bf598554ab04b9b21421ed28bff6b7742993  0x46467fd198026233313337ead2707e91890f1bde
0x58e6c7ab55aa9012eacca16d1ed4c15795669e1c  0x702cacafa54b88e9c54449563fb2e496e85c78b7
0x731bf32e20d1c5475dc85d742d4fd72faf43b889  0x7cc805e8239fa42445f2bcdc1f06b44984da6602
0x888614448eb7c766864fafb1dd20ff0b47988a87  0xa656a512000c64d2f86fb7ca15fa95dd556f18c0
0xac99b73afcb9ba791178e6d405b12d8e1b4adf85  0xbf994ad264baa1acdfe18433606a0f5d35c804f4
0xd42270832b791343a0078fcdfb06d0f3ab69b5e7  0xde4aaf47413e87bf469c13ac4647c985b2fc6846
0xfb2ad9007f2d62a973f71af206242ee4bd790b2c
```

(Listed lowercase here; the file stores checksummed addresses.) No account has a non-zero `kycAmount` today, so the first Aegis export will report `newlyApproved: []`. The file is loaded relative to the module (`../../data/kyc.json`), which resolves identically from `src/` and `dist/`. The Docker image copies `data/`. `cmd:rewards` and `cmd:kyc` keep their flags for the SEF fallback flow, but default to the file's values, so both paths agree.

### Sanctions

`sanctions-address-lists` publishes dated, immutable snapshot releases (`data-YYYY-MM-DD`) alongside the moving `latest`. The export uses the **newest `data-*` release published at or before `toTimestamp`**. Like the onchain oracle, which is evaluated at `toTimestamp`, this makes the offchain lists a function of the period too. The existing `SANCTIONS_ADDRESS_LISTS_URL` mechanism is pointed at `…/releases/download/<tag>`, and the SHA-256 of each list is recorded. `cmd:verify` re-resolves the tag with the same rule and checks the hashes. Following the resolved decision below, the GitHub release history is trusted exactly as much as this repository's own git history.

### New commands and flags

| Command | Purpose |
| --- | --- |
| `cmd:export` | Build a package and release assets for an explicit period on top of the ENS-pinned rewards DB |
| `cmd:verify` | Re-derive a package from its manifest and compare; optional onchain checks |

`cmd:export` takes the following flags:

- `--rewardPeriodStart` and `--rewardPeriodEnd`, both required, with no implicit "last Tuesday". This one period covers both validator and sentinel rewards, and there is no separate sentinel period option.
- `--previousCar <file>`, optional. It is a local source for the ENS-named CID; without it, the CAR is fetched from `IPFS_GATEWAY_URL`.
- `--out <dir>`.
- The existing `--totalRewards`/`--sentinelRewards`/`--minPayout` overrides. There is no `--kycThreshold`, because the threshold comes from `data/kyc.json`.

`cmd:verify` takes `--package <car|dir>` (required), `--previousCar`, and `--postExecution`. The last flag expects the onchain root and the ENS `contenthash` to equal _this_ package rather than the previous one.

`cmd:rewards` and `cmd:kyc` take `--transactions <dir>` for their Safe transaction bundle, instead of writing it into the rewards directory.

`cmd:index` gains `--validate`. It runs `PRAGMA integrity_check`, checks that every `event_indexers` row is within `--maxLag` seconds (default 3600) of its chain head, and runs a smoke query over the last complete period that needs no RPC.

### Configuration

| Variable | Description | Default in `.env.sample` |
| --- | --- | --- |
| `REALITY_MODULE_ADDRESS` | Zodiac Reality Module on the Governance Safe | `0x8DFc5Db2C83200Cf0cC84d7e3C441d7721ef83dC` |
| `REWARDS_ENS_NAME` | ENS name whose `contenthash` pins the rewards DB | `rewards.safenet-gov.eth` |
| `IPFS_GATEWAY_URL` | Trustless gateway that previous rewards DB CARs are fetched from (verified, so untrusted) | `http://127.0.0.1:8080` (local Kubo) |

`CUMULATIVE_MERKLE_DROP_ADDRESS` is reused. Everything else comes from the module or ENS (see above). `SETTLEMENT_BLOCKS` and the IPFS import parameters are constants, not configuration, because changing them changes the output.

### GitHub Actions

Both workflows read `STAKING_RPC_URL` and `CONSENSUS_RPC_URL` from repository secrets.

`.github/workflows/index.yml` (daily and `workflow_dispatch`):

- `concurrency: index-snapshot`, `permissions: contents: write`.
- Download `safenet.db.zst` from the `index-snapshot` release. If that fails, fall back to `safenet.db.previous.zst`, then to an empty database. The first run starts empty and indexes from the Aegis consensus deployment block.
- `cmd:index`, then `cmd:index --validate`.
- Re-upload the old current asset as `safenet.db.previous.zst`, then the new one as `safenet.db.zst` (`gh release upload --clobber`). In this order, a failure in between always leaves one good snapshot. The Beta database was about 300 MB uncompressed, well below the 2 GiB asset limit.

`.github/workflows/distribution.yml` runs on a weekly schedule and on `workflow_dispatch` (with optional explicit period and opt-in "verify from genesis" inputs):

- **plan** job: read the ENS-pinned CID and its `rewardsUntil`. Compute the next period as `[rewardsUntil, rewardsUntil + 2 weeks]`, with the one-off Beta → Aegis exception (`[2026-10-13, 2026-10-27]`). Exit cleanly if that period has not settled yet or already has a release. A release that already exists means a proposal is in flight. This makes the weekly schedule idempotent against the two-week cadence.
- **export** job: restore the snapshot, then run `cmd:index` and `cmd:export`. The previous CAR comes from the release whose `cid.txt` matches, if there is one. Otherwise it comes from the `IPFS_GATEWAY_URL` repository variable, which must point at a reachable trustless gateway; the runner has no local node. This applies at least to the first run, whose previous rewards DB (`bafybeiczeo7…`) predates the releases. Upload the release assets as a workflow artifact.
- **verify** job: on a separate runner, run a fresh `npm ci`, restore the snapshot, and run `cmd:verify` against the artifact.
- **release** job: `gh release create rewards-<toTimestamp>` with the assets, and notes giving the CID, root, amount and new KYC approvals, the Safe Transaction Builder instructions, and the non-canonical disclaimer. No environment protection, no required reviewers.

### Test cases

- Merkle DB index: a `latest.json` without `updatedAt` (the currently pinned format) parses, and a rebuild writes none.
- Beta → Aegis gap: `fromTimestamp = 2026-10-13` on top of `rewardsUntil = 2026-10-06` is accepted. Any other gap or overlap is still rejected.
- Settlement: a reveal and an attestation at `settlementBlock` count, and ones at `settlementBlock + 1` do not. The result is identical whether the harness chain is indexed to settlement or far past it.
- Block lookup: the exact boundary for a timestamp that falls between blocks, on a block, before the start block, and after the head.
- Merkle DB: two `distribute` runs on identical input produce byte-identical directories.
- KYC:
  - the committed `data/kyc.json` parses, its accounts are sorted with no duplicates, and its threshold is a valid amount.
  - a payout at or above the file's threshold is withheld for an unlisted account and paid for a listed one.
  - a listed account's withheld amount is released in the same rebuild as the period's distribution.
  - listing an already-approved account, or an account with no entry, is harmless.
  - an account flagged in the previous DB but missing from the file is refused.
- Sanctions: the snapshot-tag selection rule at the period boundary, and hash mismatch detection.
- IPFS:
  - the fixture directory CID equals a Kubo-computed constant.
  - input order does not change the CID.
  - a CAR round-trips to identical files.
  - a CAR with a tampered block, or a different root, is rejected.
- Previous resolution: an ENS `contenthash` decodes to the expected CID. A root mismatch between `latest.json` and `merkleRoot()` is refused.
- Transactions: the Zodiac hash and question ID for a fixed proposal equal vectors read from the deployed module. The `contenthash` encoding round-trips the current record `0xe30101701220…`.
- Export/verify: an export from a harness scenario verifies. Flipping one byte in any file, the CID, a transaction or an action bundle fails verification with a precise diff.

---

## Implementation Phases

```
1 (drop updatedAt) ───────────┐
3 (tx bundles out) ─► 4 ──────┼─► 14 (manifest/assembly) ──┐
8 (KYC file) ─────────────────┤                            │
9a ─► 9b ─► 9c (sanctions) ───┘                            │
2 (Beta → Aegis gap) ─► 2a (Aegis budget) ─────────────────┤
5 (block lookup) ─► 6 ─► 7 ────────────────────────────────┼─► 15 (export) ─► 16 ─► 17 ─► 19 ─► 20 ─► 21
10a (pack) ┬─► 11a ─► … ─► 11e ─► 13 (action bundles) ─────┤                                ▲
           └─► 10b (unpack) ─► 12 (previous resolution) ───┘                                │
18 (daily index Action) ────────────────────────────────────────────────────────────────────┘
```

Phase 13 also depends on Phase 3 for the pure `transactionBundle()`. Phases 9d (docs) and 9e (GitHub token) follow 9c. The **Depends on** lines below are authoritative.

Phases 1, 2, 3, 5, 8, 9a, 10a and 18 can all be developed in parallel.

### Phase 1 — Drop `updatedAt` from the Merkle DB index

**Files:** `src/merkledb/index.ts`, `tests/merkledb-index.test.ts` **Estimate:** ~40 LOC, 2 files

Removes `updatedAt` from `IndexData` and stops writing it, matching the currently pinned rewards DB. `zIndexData` currently requires it, so reading that rewards DB fails today (`expected date, received Invalid Date`). This is a fix in its own right, independent of the rest of the epic.

### Phase 2 — Allow the Beta → Aegis gap

**Files:** `src/merkledb/index.ts`, `tests/merkledb-gap.test.ts` **Estimate:** ~50 LOC, 2 files

Adds the hard-coded exception to the contiguity check in `distribute`: `rewardsUntil = 2026-10-06` may be followed by `fromTimestamp = 2026-10-13`, and nothing else changes. The constants carry a comment pointing to the Aegis proposal.

### Phase 2a — Aegis validator budget

**Depends on:** 2 **Files:** `src/utils/args.ts`, `src/utils/args.test.ts` **Estimate:** ~60 LOC, 2 files

Replaces the Beta budget in `totalRewardsAmount` (4,500,000 SAFE over 26 weeks from 2026-04-07) with the Aegis one: 5,000,000 SAFE over 52 weeks from `AEGIS_REWARDS_START` (2026-10-13), prorated by period duration as before. Without it, `totalRewardsAmount` with `--record` returns `0n` on top of the pinned rewards DB, because 26 weeks of Beta have already been paid.

With `--record`, the catch-up only counts what Aegis has distributed: the validator spend is `tokenTotal − sentinelTokenTotal` minus the Beta `tokenTotal` pinned at `rewardsUntil = 2026-10-06` (`4499987774807670271201970`, with no sentinel spend), and the elapsed time is measured from 2026-10-13. Beta's leftover `unpaidAmount` (`12225192329728798030`, the dust that keeps Beta at exactly 4.5M SAFE) is **not** carried into Aegis. It is lost, and the first Aegis `distribute` overwrites it. An index whose `rewardsUntil` is still the Beta end gets the full first-period amount.

Beta code that is no longer exercised is **removed**, not kept alongside the Aegis code. Computing Beta rewards is no longer supported, so this covers the Beta reward amounts and budget computation, their constants, and any branch that only Beta-era periods or indexes can reach. The only Beta values that stay are the ones Aegis reads: `BETA_REWARDS_UNTIL` for the gap and the pinned Beta `tokenTotal` for the catch-up.

### Phase 3 — Move transaction bundles out of the rewards directory

**Files:** `src/utils/bundle.ts`, `src/cmd/rewards.ts`, `src/cmd/kyc.ts`, `README.md`, `AGENTS.md` **Estimate:** ~80 LOC, 5 files

Splits a pure `transactionBundle(transactions, createdAt)` out of `writeTransactionBundle`. `cmd:rewards` and `cmd:kyc` then write to `--transactions <dir>` instead of `<record>/assets/rewards/transactions/`, still with the wall-clock `createdAt`.

### Phase 4 — Root `MerkleDb` at a rewards directory (refactor)

**Depends on:** Phase 3 (same commands) **Files:** `src/merkledb/index.ts`, `src/utils/args.ts`, `src/cmd/rewards.ts`, `src/cmd/kyc.ts`, `tests/merkledb-sentinel-total.test.ts` **Estimate:** ~50 LOC, 5 files

`new MerkleDb({ root })` takes the rewards directory itself, and the commands derive it from `--record` as they do today. There is no behaviour change. The export can then operate on an unpacked CAR directly.

### Phase 5 — Block-at-timestamp lookup

**Files:** `src/utils/blocks.ts`, `src/utils/blocks.test.ts` **Estimate:** ~90 LOC, 2 files

Binary search for the last block with `timestamp ≤ t`, using `getBlock` with the existing backoff.

### Phase 6 — Settlement window for sentinel reveals

**Depends on:** Phase 5 **Files:** `src/data/sentinels.ts`, `src/indexing/sentinels.ts`, `src/safenet.ts`, `tests/sentinel-participation.test.ts`, `README.md` **Estimate:** ~150 LOC, 5 files

Adds:

- `SETTLEMENT_BLOCKS`, with the `safenet-monitor` rationale as a comment.
- the settlement computation in `Safenet`.
- `sentinel_reveals.block_timestamp`.
- the `≤ settlementTimestamp` predicate.
- indexing the oracle up to settlement.

Documents that a period's participation and rewards become available 48 consensus blocks after it ends.

### Phase 7 — Settlement window for transaction attestations

**Depends on:** Phase 6 **Files:** `src/data/attestations.ts`, `src/indexing/transactions.ts`, `src/safenet.ts`, `tests/settlement.test.ts` **Estimate:** ~120 LOC, 4 files

Adds `signing_ceremonies.attested_block_timestamp` and the settlement predicate in both participation queries. It has no migration code, because indexing starts from a new database. It is kept separate from Phase 6 because it is the only change that touches validator accounting.

### Phase 8 — KYC approvals file

**Files:** `data/kyc.json`, `src/merkledb/index.ts`, `src/distribution/kyc.ts`, `src/cmd/rewards.ts`, `src/cmd/kyc.ts`, `tests/kyc.test.ts`, `Dockerfile`, `AGENTS.md` **Estimate:** ~160 LOC, 8 files

Covers:

- `data/kyc.json`, seeded with the 7,500 SAFE threshold and the 13 end-of-Beta accounts.
- the zod-validated loader (sorted, no duplicates, valid threshold).
- `cmd:rewards`/`cmd:kyc` defaulting to the file's values.
- `kycApprovals: Address[]` in `Filters`, applied before the payouts in `distribute`, which reports newly approved accounts and refuses previously flagged accounts that are missing from the file.
- `COPY data/` in the Docker image.
- documenting `data/` and the SEF edit process in `AGENTS.md`.

### Phase 9 — Pinned sanctions snapshots

Split into 9a–9d during review to keep each PR small. Each sub-phase is its own commit, branch and PR. Phase 9 has no commit of its own.

### Phase 9a — GitHub releases client

**Files:** `src/utils/gh.ts`, `src/utils/gh.test.ts` **Estimate:** ~100 LOC, 2 files

A small client for a GitHub repository's releases, so the GitHub logic is separate from the sanctions logic. It holds the zod parser for an `owner/name` repository, lists a repository's release tags through the unauthenticated REST API (paged, with the existing backoff), and downloads a release asset's raw bytes from `https://github.com/<repo>/releases/download/<tag>/<asset>`.

### Phase 9b — Sanctions lists from a GitHub repository

**Depends on:** 9a **Files:** `src/data/sanctions.ts`, `src/data/sanctions.test.ts`, `src/safenet.ts`, `src/utils/args.ts`, `.env.sample` **Estimate:** ~80 LOC, 5 files

Replaces `SANCTIONS_ADDRESS_LISTS_URL` with `SANCTIONS_ADDRESS_REPO` (default `safe-fndn/sanctions-address-lists`), so the lists are loaded from a release of the configured repository instead of an arbitrary URL. `sanctionedAccounts()` keeps its semantics and fetches the `latest` release through the 9a client.

### Phase 9c — Pinned sanctions snapshots

**Depends on:** 9b **Files:** `src/data/sanctions.ts`, `src/data/sanctions.test.ts`, `src/safenet.ts` **Estimate:** ~150 LOC, 3 files

Resolves the `data-*` tag for a period, fetches from it, and exposes the per-source SHA-256, with an optional `expected` release and hashes to verify against. `sanctionedAccounts()` keeps its current semantics.

### Phase 9d — Sanctions documentation

**Depends on:** 9c **Files:** `README.md`, `AGENTS.md`, `.env.sample`, `epics/2026_10_20_permissionless_reward_distribution.md` **Estimate:** docs only

Documents the repository setting and the snapshot rule, and records the Phase 9 sub-phases and their deviations in this specification.

### Phase 9e — Optional GitHub token

**Depends on:** 9d **Files:** `src/utils/gh.ts`, `src/utils/gh.test.ts`, `.env.sample`, `README.md`, `AGENTS.md` **Estimate:** ~50 LOC, 5 files

The unauthenticated GitHub REST API allows 60 requests an hour per IP, which shared Actions runners can exhaust. When `GITHUB_TOKEN` is set, `gh.ts` sends it with its GitHub requests. As an exception to the `src/utils/args.ts` convention, `gh.ts` reads `process.env.GITHUB_TOKEN` directly, and the token is not part of argument parsing. GitHub Actions provides it, and an empty or unset value means unauthenticated requests.

### Phase 10 — Deterministic IPFS packing

Split into 10a and 10b during review to keep each PR small. Each sub-phase is its own commit, branch and PR. Phase 10 has no commit of its own.

### Phase 10a — Deterministic IPFS packing

**Files:** `package.json`, `package-lock.json` (generated), `src/distribution/ipfs.ts`, `src/distribution/ipfs.test.ts`, `tests/fixtures/ipfs/**` **Estimate:** ~180 LOC excluding the lockfile, 4 files + fixtures

Adds `ipfs-unixfs-importer`, `@ipld/car`, `@ipld/dag-pb` and `multiformats`. Implements `packDirectory(dir) → { cid, car }` with the fixed import parameters and a deterministic CAR block order, and exports the parameters for the manifest's `ipfs` block. Includes the Kubo cross-check vector for both the CID and the CAR bytes.

### Phase 10b — Verified CAR unpacking

**Depends on:** 10a **Files:** `package.json`, `package-lock.json` (generated), `src/distribution/ipfs.ts`, `src/distribution/ipfs.test.ts`, `epics/2026_10_20_permissionless_reward_distribution.md` **Estimate:** ~200 LOC excluding the lockfile, 5 files

Adds `ipfs-unixfs-exporter`. Implements `unpackCar(car, expectedCid, dir)`, which verifies the whole CAR in memory before writing anything: it rejects any block whose hash does not match, any root other than `expectedCid`, missing and unreferenced blocks, and anything `packDirectory` cannot produce. Records the Phase 10 sub-phases and their deviations in this specification.

### Phase 11 — Governance Safe transactions

Split into 11a–11e during review, so that each PR adds one group of `src/distribution/transactions.ts` functions. These are pure functions with no RPC. Each sub-phase adds only the ABI entries its own code uses. The read-side and proposal ABIs move to the phases that first use them:

- Phase 12: the ENS registry's `resolver`, the resolver's `contenthash`, and the Cumulative Merkle Drop's `merkleRoot`.
- Phase 13: the Reality Module's `addProposal` and `executeProposalWithIndex`, `RealityETH_ERC20.submitAnswerERC20`, and ERC-20 `approve`.
- Phase 15: the Reality Module's config getters, and `RealityETH_ERC20.token`.
- Phase 17: the Reality Module's `getTransactionHash`, `buildQuestion` and `getQuestionId` views, and ERC-20 `balanceOf`.

Each sub-phase is its own commit, branch and PR, and Phase 11 has no commit of its own.

### Phase 11a — ENSIP-7 `contenthash`

**Depends on:** Phase 10a (CID type) **Files:** `src/distribution/transactions.ts`, `src/distribution/transactions.test.ts` **Estimate:** ~90 LOC, 2 files

`encodeContenthash(cid)` and `decodeContenthash(hex)` for `ipfs-ns` (`0xe301` ‖ CIDv1 bytes). Decoding rejects anything that is not a package CID, because Phase 12 decodes the onchain value. Tested against the onchain record of `rewards.safenet-gov.eth`.

### Phase 11b — Governance Safe calls

**Depends on:** 11a **Files:** `src/abi.ts`, `src/distribution/transactions.ts`, `src/distribution/transactions.test.ts` **Estimate:** ~90 LOC, 3 files

`governanceTransactions(update, { ensName, ensResolver })` returns the three calls in order: the SAFE `transfer` to the Cumulative Merkle Drop, `setMerkleRoot`, and `setContenthash`. Adds the ERC-20 `transfer`, `setMerkleRoot` and `setContenthash` ABI entries.

### Phase 11c — Zodiac transaction hash

**Depends on:** 11b **Files:** `src/distribution/transactions.ts`, `src/distribution/transactions.test.ts` **Estimate:** ~60 LOC, 2 files

`transactionHash(module, tx, nonce)`, the Reality Module's EIP-712 transaction hash. Tested against the deployed module's `getTransactionHash`.

### Phase 11d — Reality.eth question

**Depends on:** 11c **Files:** `src/distribution/transactions.ts`, `src/distribution/transactions.test.ts` **Estimate:** ~90 LOC, 2 files

`buildQuestion(proposalId, txHashes)` and `questionId(question, config, nonce)`, with the `GovernanceConfiguration` type. Tested against the deployed module's `buildQuestion` and `getQuestionId`.

### Phase 11e — `proposal.json`

**Depends on:** 11d **Files:** `src/distribution/transactions.ts`, `src/distribution/transactions.test.ts` **Estimate:** ~90 LOC, 2 files

`proposal(update, config)` and its `zProposal` schema, which Phases 13–16 consume.

### Phase 12 — Previous rewards DB resolution

**Depends on:** Phases 10b, 11a (CAR verification, `contenthash` decoding) **Files:** `src/abi.ts`, `src/distribution/previous.ts`, `src/distribution/previous.test.ts`, `src/utils/args.ts`, `.env.sample` **Estimate:** ~180 LOC, 5 files

Resolves the previous rewards DB as follows:

- reads `contenthash` for `REWARDS_ENS_NAME` and decodes the CID.
- obtains the CAR from `--previousCar` or `IPFS_GATEWAY_URL` (`?format=car`, default `http://127.0.0.1:8080`), and unpacks it with verification.
- requires `latest.json.merkleRoot == merkleRoot()`.
- re-packs the result and warns if the CID differs.

Adds `IPFS_GATEWAY_URL`.

### Phase 13 — Action bundles

**Depends on:** Phases 3, 11e **Files:** `src/abi.ts`, `src/distribution/actions.ts`, `src/distribution/actions.test.ts` **Estimate:** ~150 LOC, 3 files

Builds `propose.json`, `answer.json` and `execute.json` from `proposal.json` and the governance configuration, using the pure `transactionBundle()` from Phase 3.

### Phase 14 — Package manifest and assembly

**Depends on:** Phases 1, 4, 8, 9c **Files:** `src/distribution/manifest.ts`, `src/distribution/package.ts`, `src/distribution/canonical.ts`, `src/distribution/package.test.ts` **Estimate:** ~260 LOC, 4 files

Covers:

- the manifest schema, including `sanctions.offchain.repository` (see Phase 9d deviations).
- canonical JSON (sorted keys, tabs).
- writing `allocations.json` and the manifest next to a `MerkleDb` output.
- copying a previous rewards DB, with or without a manifest, into a working directory without its manifest or allocations.

### Phase 15 — `cmd:export`

**Depends on:** Phases 2, 7, 12, 13, 14 **Files:** `src/abi.ts`, `src/cmd/export.ts`, `src/distribution/governance.ts`, `package.json`, `src/utils/args.ts`, `.env.sample`, `README.md` **Estimate:** ~250 LOC, 7 files

Wires the pieces together:

1. read the governance configuration from the module.
2. resolve the previous rewards DB.
3. run `rewards` and `sentinelRewards`.
4. run `distribute` with sanctions and the threshold and approvals from `data/kyc.json`.
5. assemble the package and pack it.
6. build the transactions and bundles.
7. write the release assets and `SHA256SUMS`.

### Phase 16 — `cmd:verify` (offline)

**Depends on:** Phase 15 **Files:** `src/cmd/verify.ts`, `src/distribution/compare.ts`, `package.json`, `README.md`, `tests/export-verify.test.ts` **Estimate:** ~230 LOC, 5 files

Re-exports from the manifest (including `previous.cid`) into a temporary directory and compares every file, the CID and every derived asset, printing a per-file diff. It refuses a manifest whose `sanctions.offchain.repository` differs from the configured `SANCTIONS_ADDRESS_REPO`, with an error naming both.

### Phase 17 — Onchain consistency checks

**Depends on:** Phase 16 **Files:** `src/abi.ts`, `src/distribution/onchain.ts`, `src/cmd/verify.ts`, `README.md` **Estimate:** ~150 LOC, 4 files

Checks that:

- the governance configuration is unchanged since export.
- the Zodiac hashes and question ID match the module views.
- the Governance Safe's SAFE balance covers the transfer. This is a warning only.
- before execution, `previous.cid` is still the ENS-pinned CID.
- with `--postExecution`, the onchain root and `contenthash` equal this package.

### Phase 18 — Daily indexing Action

**Files:** `.github/workflows/index.yml`, `src/cmd/index.ts`, `README.md` **Estimate:** ~150 LOC, 3 files

Adds `cmd:index --validate` and the snapshot workflow described above. Independent of every other phase.

### Phase 19 — Distribution Action

**Depends on:** Phases 17, 18 **Files:** `.github/workflows/distribution.yml`, `README.md` **Estimate:** ~180 LOC, 2 files

The plan, export, verify and release jobs.

### Phase 20 — Operator runbook

**Depends on:** Phase 19 **Files:** `docs/permissionless-distribution.md`, `README.md` **Estimate:** docs only

Covers how to:

- reproduce and verify a package.
- load the three bundles.
- review new KYC approvals (`manifest.kyc.newlyApproved` and the `data/kyc.json` history).
- challenge an answer: compute the next bond, approve, and `submitAnswerERC20` with `max_previous`.
- read the module getters for finality, cooldown and expiration.
- handle superseded proposals: answer **No** and let the answer expire.
- deal with the SEF `RealityVetoModule`.
- re-ask an invalidated question.
- verify after execution.
- for SEF, change the threshold or add approvals.

Pinning is mentioned only as something anyone may do with the CAR. The runbook points at the governance setup's deployment record for addresses and parameters.

### Phase 21 — Remove this specification

**Depends on:** Phase 20 **Files:** `epics/2026_10_20_permissionless_reward_distribution.md` **Estimate:** deletion only

---

## Deviations

Changes that came up during implementation. Where they conflict with the rest of this specification, these entries win.

### Phase 1

- `updatedAt` is simply removed, with no handling for older indexes that still carry it. The rewards DB pinned on `rewards.safenet-gov.eth` is the genesis input and has no `updatedAt`, so none should ever be read.
- `zIndexData` and `zDistributionData` are `z.strictObject`s instead of `z.looseObject`s, and `DistributionData` has no index signature: every field is declared and written, and a file with an unknown field fails to parse. The pinned `latest.json`'s `epoch` (`0`) is declared as `epoch: number`, unused, and carried over unchanged.
- A rebuild recomputes `tokenTotal` from the entries under `proofs/`. A fixture `latest.json` whose `tokenTotal` doesn't match its proof entries has that total replaced on the first rebuild.
- Fixed: `MerkleTreeMap` (`src/merkledb/treemap.ts`) used to loop forever with zero leaves, so any rebuild where no account has `cumulativeAmount > 0` hung. An empty tree now has root `zeroHash`, which no proof verifies against. That matches the `CumulativeMerkleDrop` before its first root is set and the `merkleRoot` default of a new distribution entry. Proofs for absent accounts are `null`, as before.
- Fixed: `kyc()` used to reset `unpaidAmount` to 0. A KYC rebuild distributes nothing, so it now leaves `unpaidAmount` unchanged. Only `distribute` sets it.

### Phase 2

- The Beta → Aegis exception replaces the contiguity rule for that one boundary instead of adding to it. When `rewardsUntil = 2026-10-06`, the only period start `distribute` accepts is `fromTimestamp = 2026-10-13`. A contiguous period starting on 2026-10-06 is rejected (`null`), so the gap week can't be paid by mistake. For example, a fallback `cmd:rewards --record` run with the default `rewardsPeriod()` on Tuesday 2026-10-20 would otherwise compute [2026-10-06, 2026-10-20]. Every other `rewardsUntil` still needs an exactly contiguous period.
- The Phase 1 tests in `tests/merkledb-index.test.ts` distribute on top of the pinned `rewardsUntil = 2026-10-06`, so they now use the first Aegis period [2026-10-13, 2026-10-27] instead of [2026-10-06, 2026-10-20].
- The program constants set by the DAO live in a new `src/utils/sep.ts` (Safe Ecosystem Proposal). Phase 2 adds `BETA_REWARDS_UNTIL` and `AEGIS_REWARDS_START`, and `src/merkledb/index.ts` imports them. `nextRewardsStart(rewardsUntil)` is exported from `src/merkledb/index.ts` so that the budget can reuse the gap rule.

### Phase 2a

- The Phase 2a constants go in `src/utils/sep.ts` rather than staying local to `args.ts`: `AEGIS_VALIDATOR_REWARDS` and `AEGIS_VALIDATOR_REWARDS_DURATION` (5M SAFE over 52 weeks), `BETA_TOKEN_TOTAL`, and `SENTINEL_REWARDS_PER_YEAR` and `SENTINEL_REWARDS_YEAR` (moved out of `sentinelRewardsAmount`). Tests import them instead of redefining them.
- With `--record`, `totalRewardsAmount` throws `record is not caught up to the end of Beta` when the index is missing, has no `rewardsUntil`, or has a `rewardsUntil` before `BETA_REWARDS_UNTIL`. It used to fall back to the plain prorated amount, but only Beta-era records could reach those fallbacks.
- Phase 2a also changes `tests/merkledb-sentinel-total.test.ts` and `README.md`.
  - The sentinel total test was pinned to the Beta budget and now uses Aegis periods. Its budget test seeds `BETA_TOKEN_TOTAL` through a final Beta period before crossing the gap, because a rebuild recomputes `tokenTotal` from `proofs/`. Its validator payout per period drops from 300,000 to 150,000 SAFE so that it stays within the Aegis budget.
  - The README's `--totalRewards` default describes the Aegis budget and says where `sep.ts` is.
- Remaining Beta references that stay because they are still in use or belong to other work:
  - the "Safenet Beta" product status wording in `README.md`;
  - the `safenet-beta-data` `--record` root, which later phases replace;
  - the `.env.sample` comment about the Beta consensus start block;
  - the `"Safenet Beta validator commission beneficiary"` ID, which is fixed onchain;
  - the 4.5M SAFE stake sizes in the reward scenario tests.
- `rewardsPeriod()` without an explicit period still returns the two weeks up to the last Tuesday. Aegis periods (2026-10-13, 10-27, …) are one week off the Beta grid, so on the wrong week the default gives a period that `distribute` rejects (`null`). This fails safe and is left as is. Only the comment changed.

### Phase 3

- A bundle is written only when `--transactions <dir>` (env `TRANSACTIONS`) is given. It used to be written whenever `CUMULATIVE_MERKLE_DROP_ADDRESS` was set, but `.env.sample` sets that address and Phase 15 reuses it, so it no longer signals that a bundle is wanted. Without `--transactions`, no bundle is written.
- Both commands check their flags before indexing or recording anything, so a misconfigured run fails before the rewards DB changes. With `--transactions`, both throw `--transactions requires CUMULATIVE_MERKLE_DROP_ADDRESS` if the address is unset, and `cmd:rewards` throws `--transactions requires --record` without `--record`.
- `writeTransactionBundle(dir, key, transactions)` takes the output directory itself instead of the `--record` root. It creates the directory and writes `<dir>/<key>.json` with `createdAt = Date.now()`.
- `transactionBundle(transactions, createdAt)` returns a typed `TransactionBundle`, with `createdAt` in milliseconds since the epoch (Phase 13 passes `settlementTimestamp × 1000`). The JSON shape is unchanged: `version: "1.0"`, `chainId: "1"`, `createdAt`, `meta: {}`, and per transaction `to`, `value` (default `"0"`), and `data`/`contractMethod`/`contractInputsValues` (or `null`). There is no `createdFromSafeAddress`.
- Phase 3 adds `src/utils/bundle.test.ts`, which tests the pure `transactionBundle()` and the output path of `writeTransactionBundle`.
- README and AGENTS.md no longer mention a `SAFE_TOKEN_ADDRESS` env var, which never existed. The token address is always read from the staking contract (`Safenet.safeToken()`).

### Phase 4

- `totalRewardsAmount(args, db?: MerkleDb)` takes the database as an optional second argument instead of reading `args.record`, so the export can pass a `MerkleDb` rooted at an unpacked CAR. The `record is not caught up to the end of Beta` error is unchanged.
- A new `recordRewardsDirectory(record)` in `src/utils/args.ts` maps `--record` to `<record>/assets/rewards`, so `MerkleDb` no longer knows the record layout. Both commands use it.
- `cmd:rewards` builds its `MerkleDb` once, before indexing, whenever `args.record !== undefined`, and shares it between `totalRewardsAmount` and `distribute`. Recording used to test `if (args.record)`, so the only behaviour change is that an empty `--record=` now records to a relative `assets/rewards` instead of silently skipping. `totalRewardsAmount` already treated an empty string as set.
- Phase 4 also changes `src/utils/args.test.ts`, `tests/merkledb-gap.test.ts`, `tests/merkledb-index.test.ts` and `AGENTS.md`. Test fixtures create the rewards directory directly, without `assets/rewards`.

### Phase 5

- The lookup is `blockAtTimestamp(client, { timestamp, fromBlock = 0n }, withBackoff?)` in `src/utils/blocks.ts`. It returns the last block with `timestamp ≤ t` as a `BlockTimestamp` (`{ number, timestamp }`, from `src/indexing/events.ts`), or `null`. The backoff defaults to `backoff({ debug: debug("safenet:blocks") })`.
- It searches `[fromBlock, latest]`, and callers pass the chain's start block as `fromBlock`. It fetches `latest`, then `fromBlock`, then bisects, so it makes about 2 + ⌈log2(latest − fromBlock)⌉ backed-off `getBlock` calls.
- Edge cases:
  - A `t` before the `fromBlock` block's timestamp returns `null`, and that answer is final.
  - A `t` after the latest block's timestamp throws `timestamp <t> is after the latest block`, because the answer isn't settled yet. This mirrors `EventIndexer.update`.
  - A `t` equal to the latest block's timestamp returns the latest block. That relies on strictly increasing timestamps on Ethereum and Gnosis Chain.
  - Timestamps only need to be non-decreasing. Of several consecutive blocks with the same timestamp, the last is returned.
- The search reads `latest`, not `finalized`. Settlement only uses periods that ended at least 48 blocks ago, so a reorg at the head doesn't affect it.
- The tests use a fake viem client with a `custom` transport instead of `MockChain`, because `MockChain` can't produce two blocks with the same timestamp.

### Phase 6

- `Safenet.settlement({ toTimestamp })` is public and returns `{ boundaryBlock, settlementBlock, settlementTimestamp }`, so that Phase 15 can record the consensus boundary and settlement blocks in the manifest. `src/safenet.ts` exports `SETTLEMENT_BLOCKS` (`48n`) and `Settlement`.
- The boundary is `blockAtTimestamp(consensusClient, { timestamp: toTimestamp, fromBlock: consensusStartBlock ?? 0n })`, using `Safenet`'s backoff. The start block is the consensus one, not the sentinel oracle's.
- Error cases:
  - A period ending before the consensus start block throws `period end <t> is before the consensus start block`.
  - A `toTimestamp` after the latest block throws the `blockAtTimestamp` error.
  - A settlement block beyond the latest block throws `settlement block <n> does not exist yet`. This is checked against `getBlock("latest")` first, so it fails immediately instead of after the backoff retries.
- `sentinelParticipation`, and therefore `sentinelRewards`, computes the settlement and then runs `index({ toTimestamp: settlementTimestamp })`. All 8 indexers on both chains share a single indexing horizon that covers work crossing the period boundary.
  - The staking-chain queries are bounded by the period's timestamps, so indexing that chain further doesn't change their results. Paging may index past settlement, and the predicate makes that irrelevant.
  - Because the staking chain is also indexed to `settlementTimestamp`, the call fails with `Attempting to update to a future block` until Ethereum has a block at or after that timestamp, which takes at most one more Ethereum block after the settlement block.
  - `rewards()` and validator participation still index to `toTimestamp` until Phase 7. Their results already depend on how far the consensus chain is indexed: `TransactionAttested` has no timestamp and can land after `toTimestamp`, setting `is_transaction_attestation` on ceremonies inside the period. Phase 7's `attested_block_timestamp ≤ settlementTimestamp` predicate removes that dependency.
- `selectParticipation` adds `AND v.block_timestamp <= @settlementTimestamp`. `requestCount` stays bounded by `toTimestamp`. `SentinelData.participation` takes a new `SettledRange` (`TimestampRange & { settlementTimestamp }`) from `src/utils/ranges.ts`, so that Phase 7 can reuse it.
- `sentinel_reveals.block_timestamp` is a plain `INTEGER NOT NULL` column with no index, because it is only filtered after the join on `request`.
- `totals()` (from #83) counts revealed requests with no period or settlement bound. It is a "current totals" metric, so it deliberately has no settlement predicate. #82 forces nothing: `Revealed` is unchanged, and the new `OracleResult` event is not indexed.
- Files beyond the phase's list:
  - `src/utils/ranges.ts` (`SettledRange`).
  - `tests/sentinel-rewards.test.ts`, whose scenarios are extended by `SETTLEMENT_BLOCKS`.
  - `AGENTS.md`, which documents the genesis block and the settlement requirement for scenarios. Harness scenarios that query sentinel participation or rewards must extend the consensus chain by `SETTLEMENT_BLOCKS` and the staking chain to at least the settlement timestamp.
  - `tests/harness/chain.ts`: `MockChain` gets an empty genesis block 0 at t=0, with `parentHash = zeroHash`. The harness sets no consensus start block, so `blockAtTimestamp` needs block 0 to exist. `consensusStartBlock: 1n` doesn't work instead, because `EventIndexer` fetches block 0 for its initial timestamp.
- The settlement tests live in `tests/sentinel-participation.test.ts`. Phase 7 creates `tests/settlement.test.ts` for attestations.

### Phase 7

- `signing_ceremonies.attested_block_timestamp` (a nullable `INTEGER` with no index) **replaces** `is_transaction_attestation` rather than being added next to it. "Attested" is `attested_block_timestamp IS NOT NULL`, and the settlement predicate already excludes `NULL`, so the flag would be a column nothing queries. Its low-selectivity `signing_ceremony_is_transaction_attestation_idx` is dropped. The new column needs no index, because it is only filtered after the range scan on `completed_block_timestamp`.
- The ceremony upsert keeps the first attestation timestamp, `COALESCE(attested_block_timestamp, @attestedBlockTimestamp)`. A `Sign` event (which passes `NULL`) and a repeated `TransactionAttested` never overwrite it.
- A ceremony still belongs to the period its `SignCompleted` falls in (`completed_block_timestamp` in [from, to]). Its `TransactionAttested` must be at or before `settlementTimestamp`, so an attestation after the period end but before settlement counts.
- A private `Safenet#settle(period): Promise<SettledRange>` computes `settlement()`, indexes every indexer to `settlementTimestamp`, and logs the period. `sentinelParticipation`, `participation`, `rewards`, `validatorStats` and `staked` each call it exactly once. `#validatorRegistrations` no longer indexes.
- `validatorStats` and `staked`, and so `cmd:validators` and `cmd:stake`, also index to the settlement and fail until it exists, even though they only read staking data. This keeps a single indexing horizon for every period query.
- The settlement is computed once per public call. `cmd:rewards` (`rewards` + `sentinelRewards`) and `cmd:participation` (`participation` + `sentinelParticipation`) therefore compute it twice. The second time only repeats the block lookup and an index update with nothing left to fetch. Sharing it would change the public method signatures.
- Files beyond the phase's list:
  - the seven validator reward tests (`single`, `dust`, `participation`, `self-rewards`, `fancy-delegates`, `block-times` and `self-stake`), extended to settlement with no change in expectations;
  - `README.md`, where the settlement text now covers validators and sentinels, and `cmd:validators`/`cmd:stake` say they wait for settlement;
  - `AGENTS.md`, which lists every period query under the settlement note and says `SignCompleted` must be in the period and `TransactionAttested` at or before settlement.
- `tests/settlement.test.ts` builds late attestations with local helpers (`completedCeremony`, `attestation(seed)`) rather than with a new `presets.ts` option.

### Phase 8

- The KYC file is `src/distribution/kyc.json`, not `data/kyc.json`. Wherever this spec says `data/kyc.json` or `data/`, read `src/distribution/kyc.json`. `src/distribution/kyc.ts` imports it (`import KYC_JSON from "./kyc.json" with { type: "json" }`), so `tsc` emits it into `dist/` and it's part of the build instead of being loaded relative to the module at runtime. No tsconfig change was needed, because `module: "NodeNext"` turns on `resolveJsonModule`.
- The KYC threshold lives in the same file (`threshold`), not in `src/utils/sep.ts`. The DAO didn't set it. SEF does, through the same reviewed PRs as the approvals. The 7,500 SAFE value comes from this spec. Before, `--kycThreshold` had no default, and the README examples used `1000`.
- `src/distribution/kyc.ts` exports only `kyc(): Kyc`, which validates the imported JSON with its zod schema on every load, where `Kyc = { accounts: Address[]; threshold: bigint }`. There is no `KYC_FILE` and no runtime path resolution.
- The input is a fixed, committed file, so there are no tests for each validation rule. `tests/kyc.test.ts` only checks that the committed file parses to a non-empty `accounts` and a positive `threshold`, and a broken edit fails that test and every command that loads the file. This replaces the loader tests listed under Testing.
- The schema is a `z.strictObject`.
  - Accounts must already be checksummed. A lowercase address is rejected rather than normalized.
  - Accounts must be sorted, and are checked for duplicates without regard to case.
  - `threshold` is a decimal string matching `^\d+(\.\d{1,18})?$`, parsed with `parseUnits(…, 18)`, and must be greater than 0.
- `Filters.kycApprovals: Address[]` is required, and `kycThreshold` stays optional. `distribute` reports `newlyApproved` (see `ApprovalsUpdate` below).
- `distribute` runs these steps in order:
  1. the contiguity check, which returns `null`;
  2. the refusal check, which throws `KYC-approved account <addr> is missing from the approvals` if any entry has `kyc: true` but isn't listed;
  3. flagging every listed account through a private `#approve(account)`, which `kyc()` now shares and which sets `kyc: true` and releases `kycAmount`;
  4. the payouts;
  5. the rebuild.
- A listed account with no entry gets one with nothing to claim (`cumulativeAmount: 0`, `proof: null`), as `kyc()` already did. It is reported in `newlyApproved` once, and not again in later periods.
- `cmd:rewards` loads the KYC file before indexing, so `--kycThreshold` defaults to the file's threshold. With `--record`, it passes the file's accounts as `kycApprovals` and prints `New KYC Approval: <addr>` for each newly approved account. It no longer spreads `...args` into the filters.
- `cmd:kyc` takes no accounts on the command line, so `util.parseArgs` rejects any address passed. It always applies the complete list in `src/distribution/kyc.json`, which is therefore the only way to approve an account.
  - The command stays so that SEF can update the DB between two distributions, for example to release withheld amounts.
  - It keeps the existing period check: `MerkleDb.kyc()` throws `attempt to update KYC status for wrong rewards period` unless the DB's `rewardsUntil` equals the period's `toTimestamp`.
  - It prints `Merkle Root: <root>`, then either `New KYC Approval: <addr>` for each newly approved account or `No new KYC approvals.`.
  - If the rebuilt root equals the previous `merkleRoot`, it prints `Merkle root unchanged, no transaction needed.` and writes no bundle, even with `--transactions`. This depends on the root, not on `newlyApproved`: a newly approved account with nothing withheld leaves the root unchanged, and a newly sanctioned account changes it without any approval.
- `MerkleDb.kyc(period, approvals, sanctions)` treats `approvals` as the complete list and returns `ApprovalsUpdate` (`Update & { newlyApproved: Address[] }`). `distribute` returns `ApprovalsUpdate | null`.
  - Both share a private `#applyApprovals`. It throws `KYC-approved account <addr> is missing from the approvals` when a flagged entry is missing, flags every listed account, and returns the newly flagged ones sorted by address.
  - In `kyc()` this runs after the period check.
  - A refusal or a period error throws while the lock is held, so `.lock` stays behind and has to be removed by hand. That is intended, because it shouldn't happen in practice.
- `#rebuildTree` no longer releases `kycAmount` for entries already flagged `kyc: true`. Every rebuild goes through `#applyApprovals` first. A listed account is released by `#approve`, an unlisted flagged account aborts the run, and `#distributeTo` never withholds from a flagged entry, so the branch could no longer be reached. It is removed with no replacement assertion.
- The `Dockerfile` is unchanged, and the image doesn't copy `data/`. The builder stage already copies `src/`, so `kyc.json` reaches `dist/distribution/` through the build.
- Files beyond the phase's list:
  - `README.md`, which describes the threshold default and the approval and refusal behaviour, and drops `--kycThreshold=1000` from its examples;
  - the three `tests/merkledb-*.test.ts` files, which pass `kycApprovals: []`.
- `AGENTS.md` has a new "Distribution Inputs" section. Inputs that are neither onchain nor SEP constants are JSON files under `src/`, imported and zod-validated, and pinned by the commit. It also covers the SEF edit process: add an account in sorted position and never remove one, because approvals are sticky.

### Phase 9

These entries describe the behaviour of Phase 9 as a whole. The 9a–9d entries below say how it was split and win where they differ.

- **Choosing the snapshot.** A period's snapshot is the newest `data-YYYY-MM-DD` release whose UTC day has *ended* at or before `toTimestamp` (`Date.UTC(Y, M-1, D)/1000 + 86400 ≤ toTimestamp`), because the upstream publish job can re-upload `data-D` until day D is over.
  - The date comes from the tag name only. GitHub's `published_at`/`created_at` are ignored.
  - Tags that don't match `^data-\d{4}-\d{2}-\d{2}$`, or aren't real calendar dates, are skipped, and `latest` is never selected.
  - When no snapshot qualifies, the call throws `no sanctions address lists snapshot ended by <toTimestamp>`, with no fallback to `latest`.
  - A snapshot of any age is accepted, because upstream only publishes on days when the lists change.
- **Finding the tags.** Tags come from the unauthenticated GitHub REST API (`https://api.github.com/repos/<repo>/releases?per_page=100&page=N`). The listing is paged until a page has fewer than 100 entries, and every request goes through the existing backoff.
- **Configurable source.** The lists come from one GitHub repository, `SANCTIONS_ADDRESS_REPO` (`--sanctionsAddressRepo`), which replaces `SANCTIONS_ADDRESS_LISTS_URL`, so wherever this spec says `SANCTIONS_ADDRESS_LISTS_URL`, read `SANCTIONS_ADDRESS_REPO`. Lists can no longer be loaded from an arbitrary URL.
  - The value is a GitHub `owner/name`, parsed by `zGitHubRepository` (see Phase 9a).
  - It defaults to `DEFAULT_SANCTIONS_ADDRESS_REPO` = `safe-fndn/sanctions-address-lists` (the repository moved from `safe-research`), applied in `SanctionsData` like other optional config.
  - Every URL derives from it: live lists from `https://github.com/<repo>/releases/download/latest/<source>.json`, snapshots from `…/releases/download/<tag>/<source>.json`, and the listing from `https://api.github.com/repos/<repo>/releases`.
- **Hashing.** The SHA-256 is computed over the raw bytes of each `<source>.json` asset as served, before parsing, as lowercase hex with no `0x`, so `sha256sum` reproduces it. Hashes are keyed by source ID (`un`, `eu`, `uk`, `ch-seco`, `us-ofac`), matching `manifest.sanctions.offchain.sha256`. Upstream's `manifest.json` is neither fetched nor hashed.
- **API.** `selectSnapshotRelease(releases, { toTimestamp })` is pure, and `SanctionsData.snapshotRelease(period)` resolves the tag.
  - `SanctionsData.pinnedSanctionedAccounts(period, expected?)` and `Safenet.pinnedSanctionedAccounts(period, expected?)` return `{ accounts, offchain: { release, sha256 } }`, where `offchain` is exactly the manifest's `sanctions.offchain` and `accounts` is the onchain sanctions at `toTimestamp` plus the snapshot lists.
  - With `expected`, a different resolved tag throws `sanctions address lists snapshot <resolved> does not match expected <release>`, and a different hash throws `sanctions address list <source> in <release> has SHA-256 <actual>, expected <expected>`.
  - Hash checks run outside the backoff and are not retried. Network and HTTP errors, including a 404 for a missing asset, are retried and then thrown.
- **Indexing.** `Safenet.pinnedSanctionedAccounts` indexes only the sanctions indexer, up to `toTimestamp`, like `sanctionedAccounts`. The onchain sanctions query is bounded by `toTimestamp`.
- **Commands.** `sanctionedAccounts()` keeps its live `latest` semantics, and `cmd:rewards`, `cmd:kyc` and `cmd:sanctions` are unchanged in this phase.
- **Files.** Each sub-phase lists its own files. `src/utils/args.ts` and `.env.sample` are in 9b, and `README.md` and `AGENTS.md` are in 9d.

### Phase 9a

- `src/utils/gh.ts` exports functions, not a class, like `blockAtTimestamp`: `releaseTags(repo, withBackoff?)` and `releaseAsset(repo, { tag, asset }, withBackoff?)`. The backoff defaults to `backoff({ debug: debug("safenet:gh") })`, and callers pass their own to keep their debug namespace.
- `zGitHubRepository` parses `owner/name` into `GitHubRepository` (`` `${string}/${string}` ``). The owner is 1–39 alphanumerics with single inner hyphens, and the name is 1–100 of `[A-Za-z0-9._-]`, but not `.` or `..`.
- `releaseTags` returns tags in API order from `https://api.github.com/repos/<repo>/releases?per_page=100&page=N`, paging until a page has fewer than 100 entries. A page of exactly 100 therefore costs one more request, for an empty page. Only the request is retried; a malformed listing throws at once.
- `releaseAsset` returns the raw bytes as served, so a caller can hash them before parsing. A non-OK response, including a 404, throws `failed to fetch '<url>': <status> <statusText>` after the retries.
- `tag` and `asset` are URL-encoded with `encodeURIComponent`. This changes nothing for `latest`, `data-YYYY-MM-DD` or `<source>.json`.
- Requests are unauthenticated and send no `Accept` or API-version headers, as before.

### Phase 9b

- `SANCTIONS_ADDRESS_REPO` (`--sanctionsAddressRepo`) is parsed with `zGitHubRepository.optional()` and typed `GitHubRepository` through `Safenet.create` and `SanctionsDataConfiguration.sanctionsAddressRepo`. Since the type carries the validation, `SanctionsData` does not validate again.
- The default is `DEFAULT_SANCTIONS_ADDRESS_REPO` in `src/data/sanctions.ts`, applied with `??` in the `SanctionsData` constructor, like other optional config. The args field has no `.default()`.
- The default moves from `safe-research` to `safe-fndn`, because the upstream repository moved.
- `sanctionedAccounts()` fetches `<source>.json` from the `latest` tag with `releaseAsset(repo, { tag, asset }, this.#backoff)`, keeping the `safenet:sanctions-lists` debug namespace. The internal list fetch takes the tag as a parameter.
- JSON parsing now happens after the backoff instead of inside it (`response.json()`), so a malformed list throws at once instead of being retried. HTTP errors are still retried and then thrown, with the same `failed to fetch '<url>': <status> <statusText>` message.

### Phase 9c

- `snapshotRelease(period)` gets its tags from the 9a `releaseTags(repo, this.#backoff)` and applies `selectSnapshotRelease`. Paging is not tested again in `sanctions.test.ts`.
- Live and pinned lists share one code path that takes a tag. `#fetchOffchainSource(tag, source)` hashes the raw `releaseAsset` bytes and returns `{ sha256, accounts }`. `sanctionedAccounts()` passes `latest`, and `pinnedSanctionedAccounts` passes the resolved `data-*` tag.
- The `expected` release is checked before any asset is fetched. Hashes are compared after all five assets have downloaded, outside the backoff, so a mismatch is never retried.
- The tests check hashes against constants computed with `sha256sum`, not against an in-test `createHash`.

### Phase 9d

- `README.md` matches the unsplit Phase 9 word for word. `AGENTS.md` differs only in its `SanctionsData` paragraph, which names the `src/utils/gh.ts` releases client (`releaseTags`, `releaseAsset`) instead of saying the URLs derive from the repository, and says the SHA-256 is over each source's raw asset.
- `AGENTS.md` mentions `src/utils/gh.ts` only in the `SanctionsData` paragraph, not in the project structure notes.
- `.env.sample` is also in 9d: its `SANCTIONS_ADDRESS_REPO` comment gets back the original's sentence about the dated snapshot releases.
- **The manifest records the repository.** A release tag and its hashes only identify the lists within one repository, so `manifest.sanctions.offchain` gains `repository` (the configured `SANCTIONS_ADDRESS_REPO`, an `owner/name`).
  - `pinnedSanctionedAccounts` and `OffchainSanctions` are unchanged. The export (Phases 14–15) takes the repository from the configuration, through a `SanctionsData` accessor if needed, and writes it next to `release` and `sha256`.
  - `cmd:verify` (Phase 16) refuses a manifest whose repository differs from the configured one, with an error naming both, instead of reporting a confusing tag or hash mismatch.

### Phase 9e

- Only `releaseTags` (`api.github.com`) sends `Authorization: Bearer <token>`, and `releaseAsset` is never authenticated. Asset downloads don't count against the REST API rate limit, and they redirect to an asset host on another domain. Node's fetch drops `Authorization` on cross-origin redirects, but the token isn't sent there at all.
- `process.env.GITHUB_TOKEN` is read on every listing request, not at module load. An unset or empty value sends no header.
- The token is never put in a URL. Errors stay `failed to fetch '<url>': <status> <statusText>`, so neither errors nor backoff logs contain it.
- A rejected token (401/403) is retried and then thrown like any other HTTP error, with no fallback to unauthenticated requests.
- Actions doesn't export `GITHUB_TOKEN` as an environment variable by itself, so the workflow steps in Phases 18 and 19 that resolve a sanctions snapshot set `env: GITHUB_TOKEN: ${{ github.token }}`.

### Phase 10

These entries describe the behaviour of Phase 10 as a whole. The 10a and 10b entries below say how it was split and win where they differ.

- `@ipld/dag-pb` is an extra direct dependency (it was already transitive). Packing decodes dag-pb links to order the CAR blocks, and the tests use it to build hostile CARs. No blockstore package is used: in-memory `Map`s implement the importer's and exporter's `put`/`get`. `multiformats` supplies `CID`, `raw` and `sha256`.
- `src/distribution/ipfs.ts` exports:
  - `IPFS_PARAMETERS` (`as const`), exactly the manifest's `ipfs` block, and its type `IpfsParameters`;
  - `CHUNK_SIZE` (262144), `MAX_CHILDREN_PER_NODE` (174, Kubo's balanced default) and `HAMT_SHARDING_SIZE` (262144);
  - `Packed = { cid: CID; car: Uint8Array }`, with `multiformats`' `CID`. `cid.toString()` is CIDv1 base32.
- Every importer option is explicit: `cidVersion: 1`, `rawLeaves: true`, `reduceSingleLeafToSelf: true`, `fixedSize(262144)`, `balanced(174)`, `shardSplitThresholdBytes: Infinity`, `wrapWithDirectory: false`, and no `mtime`/`mode`. Importer paths get a fixed `root/` prefix, which appears in no block, so the importer yields the directory's own CID.
- Kubo shards a directory once its node reaches 256 KiB. `packDirectory` never shards, and instead throws `directory … is too large to pack unsharded` for a directory block of 262144 bytes or more, rather than silently differing from Kubo. The byte-prefix layout of `proofs/` keeps every directory far below that.
- The packing walk is depth-first, with names in byte order, and includes empty directories. Symlinks and other non-regular files are refused, and so are hidden names (`invalid entry name ".…"`), which Kubo would skip silently. That also catches a leftover `MerkleDb` `.lock`.
- The CAR's block order is a pre-order DFS from the root in link order, each block at its first occurrence only. That is `ipfs dag export`'s order, and the CAR is byte-identical to Kubo's.
- `car` is a `Uint8Array` in and out, with no streams or paths. Packages are a few MB, every caller already holds the bytes (a gateway `arrayBuffer()`, `readFile`, 9a's `releaseAsset()`), and unpacking verifies the whole DAG before writing anything.
- `unpackCar(car, expectedCid, dir)` verifies everything in memory before writing anything. It rejects:
  - a CAR that isn't version 1, or whose roots aren't exactly `[expectedCid]`;
  - any CID that isn't CIDv1 sha2-256 with the dag-pb or raw codec, which excludes identity CIDs and CIDv0;
  - a block whose hash doesn't match its CID, a missing block (`CAR is missing block <cid>`), and unreferenced blocks (`CAR has N unreferenced blocks, such as <cid>`). Duplicate blocks are accepted;
  - a root that isn't a directory, and any node other than a UnixFS `directory`, a UnixFS `file` or a raw leaf (`is an unsupported <type> node`), which covers symlinks, HAMT shards, `metadata`, UnixFS `raw` and dag-cbor/json;
  - an `mtime` or a non-default `mode`. An explicit default `mode` can't be told apart from a missing one, so it is accepted, and modes are never applied;
  - entry names that are empty, start with `.`, contain `/`, `\` or NUL, or are duplicated in a directory. Packing uses the same name check.
- The target `dir` is created if it is missing and must otherwise be empty. Files are written with flag `wx`, so nothing is ever overwritten.
- The fixture is `tests/fixtures/ipfs/` (`hello.json`, an empty `empty`, `nested/a.txt`, `nested/deeper/data.json`). The test copies it to a temp directory and adds `empty-dir/` and a deterministic 2×256 KiB + 1000 B `large.bin` (3 raw leaves). Its CID and its CAR's SHA-256 are Kubo 0.43.1 constants, and the command that computed them is recorded in the test.
- Real-data check, not committed: `packDirectory` on a scratch copy of the Beta rewards directory reproduces the pinned `bafybeiczeo7uiupwte7dfa3yaus6dogwauxbookpvcgmxebbga5jtp7afq`, its CAR is byte-identical to Kubo's, and `unpackCar` round-trips it.
- `npm run build` only compiles `src/cmd/*.ts`, so `ipfs.ts` reaches `dist/` once Phase 15 imports it.

### Phase 10a

- 10a's code and tests are a strict subset of the unsplit Phase 10, ending at `packDirectory`. `assertEntryName(name, path)` is a module-level helper that 10b reuses for unpacking.
- `ipfs-unixfs-exporter` is not in 10a's lockfile at all, not even transitively.
- `@ipld/dag-pb` is needed in 10a both to order the CAR blocks and to inspect the CAR in tests. It is used for hostile CARs only from 10b.

### Phase 10b

- None. `src/`, `tests/`, `package.json` and `package-lock.json` are identical to the unsplit Phase 10. Unpacking Kubo's CAR of the pinned rewards DB reproduces the source tree.

### Phase 11

These entries describe the behaviour of Phase 11 as a whole. The 11a–11e entries below say how it was split, and they win where they differ.

- The deployed module's question template is **6**, not 5 as the Assumptions say (read at mainnet block 26247049). Everything else in the governance setup record matches. The tooling reads the template from chain anyway.
- The arbitrator getter is `questionArbitrator()`, not `arbitrator()`, in both the Zodiac source and the deployed module. The manifest key stays `arbitrator`.
- The transfer goes to the Cumulative Merkle Drop, and its amount is `MerkleDb` `update.additionalAmount`, which is the manifest's `distribution.additionalAmount`. It is always included, even when the amount is 0, so a proposal always has exactly three transactions.
- The EIP-712 domain's `chainId` is the constant `GOVERNANCE_CHAIN_ID = 1`, not configuration, matching the bundles' fixed `chainId: "1"`.
- `decodeContenthash` and `encodeContenthash` accept only `0xe301` followed by a CIDv1 sha2-256 dag-pb CID with no trailing bytes. Other namespaces, an empty record, CIDv0 (which needs an explicit check, because `CID.decode` accepts its bytes), raw-codec CIDs and garbage are rejected.
- `zProposal` is a `z.strictObject` that checks shape only, and Phase 16 re-derives and compares:
  - `proposalId` must parse as a package CID whose base32 `toString()` equals the input;
  - `questionId` and `hash` are lowercase 32-byte hex, and `data` is lowercase hex;
  - `to` is checksummed, `operation` is the literal `0`, and `value` is a canonical decimal string;
  - `transactions` is a tuple of exactly 3.
- `proposal()` builds each transaction's keys in sorted order (`data, hash, operation, to, value`), so the object serializes the same way it parses.
- `GovernanceConfiguration` uses `bigint` for every numeric field, including the uint32 timeout, cooldown and expiration. Its keys are exactly those of the manifest's `governance` block: `answerExpiration`, `arbitrator`, `avatar`, `bondToken`, `ensName`, `ensResolver`, `minimumBond`, `module`, `oracle`, `questionCooldown`, `questionTimeout`, `templateId`.
- `src/distribution/transactions.ts` exports:
  - `encodeContenthash`/`decodeContenthash`;
  - `governanceTransactions(update, { ensName, ensResolver })`;
  - `transactionHash(module, tx, nonce)`;
  - `buildQuestion(proposalId, txHashes)`;
  - `questionId(question, config, nonce = 0n)`;
  - `proposal(update, config)`;
  - `zProposal`.

  `DistributionUpdate` is `{ additionalAmount, cid, cumulativeMerkleDrop, merkleRoot, safeToken }`.
- Each ABI entry is added by the phase that first uses it (see Phase 11). The ENS registry address (`0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e`) is not a constant yet; Phase 12 or 15 decides where it lives.
- The test vectors are read-only mainnet `eth_call`s at block 26247049: the module's `getTransactionHash`, `buildQuestion` and `getQuestionId` for a proposal re-proposing the pinned CID and root, plus the configuration getters and the onchain `contenthash`. They are hard-coded, so the tests make no network calls. The implementation follows `gnosisguild/zodiac-module-reality@main`.

### Phase 11a

- 11a's code and tests are the contenthash part of the unsplit Phase 11, unchanged. Only the module header and the test vector comment are narrowed to what 11a contains, and later sub-phases extend them.
- The ABI entries for the vector calls (ENS registry `resolver`, resolver `contenthash`) are not added. The vector is hard-coded, and Phase 12 adds those entries.

### Phase 11b

- `src/abi.ts` gains `ERC20_ABI` (`transfer` only), `CUMULATIVE_MERKLE_DROP_ABI` (`setMerkleRoot` only) and `ENS_RESOLVER_ABI` (`setContenthash` only). Later phases add their own entries to these.
- `governanceTransactions` types its options inline as `{ ensName: string; ensResolver: Address }`. 11d switches them to `Pick<GovernanceConfiguration, "ensName" | "ensResolver">` once that type exists.
- **The proposal is a single Zodiac transaction.** It is a `delegatecall` (`operation = 1`) from the Governance Safe to the canonical `MultiSendCallOnly`, which batches the three calls in the order transfer → `setMerkleRoot` → `setContenthash`, each with `operation = 0`. This overrides resolved decision 3, "Governance Safe transactions, executed one by one", and the rejected "One `MultiSendCallOnly` delegatecall" alternative. Splitting into separate transactions only works around block gas limits, and three calls are nowhere near them. Batching also makes the update atomic, so the onchain root and the ENS `contenthash` can never disagree because a proposal executed only partly.
  - `txHashes` has exactly one entry, and `execute.json` is a single `executeProposalWithIndex(CID, txHashes, to, 0, data, 1, 0)`.
  - `proposal.json` (11e) records the one transaction and its three decoded calls, so that answerers can still review each call.
  - It also overrides:
    - Overview item 11;
    - the Terminology sentence about "the Governance Safe transactions", of which there is now one;
    - the "Transactions are encoded … `operation = 0`" sentence, which now applies only to the inner calls;
    - the Action bundles table: `propose.json`'s `addProposal` has a single hash, and the bullet about the Transaction Builder batching three executions no longer applies;
    - the `proposal.json` row in the Release assets table;
    - the Zodiac nonce, which is now always 0 instead of the transaction index;
    - the `cmd:verify` sample output `Transactions: 3 / 3`;
    - the "Transactions:" test case.
  - Downstream phases:
    - Phase 13's `execute.json` makes one execution.
    - Phase 16 re-derives both the batch and its calls and checks that they agree.
    - Phase 17 checks a single Zodiac hash.
    - The runbook (Phase 20) explains the single delegatecall, and that a RealityVetoModule veto blocks the whole update, with no partial execution.
- Onchain checks, read-only, at mainnet block 26247609:
  - The Governance Safe is Safe 1.4.1 (canonical singleton), and its transaction guard and module guard slots are zero. Its modules are the Reality Module and the RealityVetoModule.
  - The Reality Module (a minimal proxy, with Zodiac `guard()` = 0) passes `operation` unchanged to `execTransactionFromModule`.
  - `MULTI_SEND_CALL_ONLY` = `0x9641d764fc13c8B624c04430C7356C1C7C8102e2`, the canonical Safe 1.4.1 deployment, with runtime code hash equal to safe-deployments' `codeHash`. It is hard-coded, not read from chain.
  - An `eth_call` from the module of `execTransactionFromModule(MULTI_SEND_CALL_ONLY, 0, batch, 1)` re-proposing the current root and CID returns `true`, both with a zero transfer and with 172,603.12 SAFE.
- The API:
  - `governanceCalls(update, ens)` returns the three inner calls (`GovernanceCall`, which is `GovernanceTransaction` with `operation: 0`, because `MultiSendCallOnly` reverts on a nested delegatecall).
  - `multiSend(calls)` packs any batch (`uint8 operation ‖ address to ‖ uint256 value ‖ uint256 length ‖ bytes data` per call) into `{ to: MULTI_SEND_CALL_ONLY, value: 0n, data: multiSend(packed), operation: 1 }`.
  - `governanceTransaction(update, ens)` is the single proposal transaction.
  - `governanceTransactions` no longer exists, and `GovernanceTransaction.operation` is `0 | 1`.
  - `src/abi.ts` gains `MULTI_SEND_ABI` (`multiSend(bytes)`).
  - No `decodeMultiSend` is exported. The tests have their own, which slices the packed bytes independently of `multiSend`.
- The test vector `BATCH_DATA` is the exact calldata simulated onchain. It was built by a separate script, not by `multiSend`.
- Effect on later sub-phases:
  - 11c hashes the one outer transaction with nonce 0.
  - 11d calls `buildQuestion` with a one-element hash array, keeping the module's `bytes32[]` signature.
  - In 11e, `proposal.json` becomes `{ calls: [3 × { data, operation: 0, to, value }], proposalId, questionId, transaction: { data, hash, operation: 1, to, value } }`.

### Phase 11c

- `ProposalTransaction` describes the one batched transaction, whose nonce is 0. `transactionHash(module, tx, nonce)` still takes the nonce explicitly, matching `getTransactionHash`.
- It is tested against the deployed module's `getTransactionHash(MULTI_SEND_CALL_ONLY, 0, BATCH_DATA, 1, 0)` at block 26247609, and against a value/delegatecall/nonce-7 vector at block 26247049.

## Open Questions and Assumptions

### Resolved decisions

1. **Settlement is 48 consensus blocks**, following the `safenet-monitor` worst-case attestation reasoning (see Architecture Decision).
2. **The previous rewards DB is the one pinned onchain.** It is the ENS `contenthash` of `rewards.safenet-gov.eth`, and it must agree with `CumulativeMerkleDrop.merkleRoot()`. There is no data repository dependency.
3. **Proposal transactions run as three separate Zodiac transactions** in the order transfer → `setMerkleRoot` → `setContenthash`.
4. **Safe Transaction Builder bundles for propose, answer and execute** replace dedicated send-transaction tooling.
5. **Stale proposals are handled socially.** While proposal _N_ is in flight, the ENS record still names _N − 1_, so the plan job sees that _N_'s period already has a release and skips. If _N_ is rejected, its release is deleted (or the period re-exported manually) and the next run rebuilds it. A superseded proposal must be answered **No** and is bounded by the module's answer expiration. No guard contract is added.
6. **GitHub history is trusted** for `sanctions-address-lists` snapshot releases to the same degree as for this repository's own history. Pinned tags plus hashes are sufficient.
7. **The rewards DB format is the currently pinned one:** no `updatedAt` and no `transactions/`.
8. **Validator and sentinel rewards share a single two-week rewards period.** The DAO proposal allows the sentinel rewards period to be collapsed into the two-week one. Sentinel grants are prorated over that period, so the manifest records one `period` and the CLI has no separate sentinel period option.
9. **The Beta → Aegis gap is a one-off, hard-coded exception** in `distribute`.
10. **There is no database migration code.** Aegis changed the schema, and indexing restarts from a new database at the Aegis consensus deployment block.
11. **The KYC threshold and approvals live in `data/kyc.json`** in this repository. SEF edits it manually, and it is pinned by `generator.commit`. It is seeded with a 7,500 SAFE threshold (below 1,000 USDC, with a buffer for price movement) and the 13 end-of-Beta approvals.
12. **RPC providers are GitHub Actions secrets.**
13. **Pinning is not part of this epic.** The IPFS gateway is configurable and defaults to a local node (`http://127.0.0.1:8080`).

### Open questions

None at the moment.

### Assumptions

- The governance setup's deployment record (reviewed 2026-10-09 at block 26155034), rechecked onchain on 2026-10-21, is authoritative:
  - Governance Safe `0xAd219b3c26fe42BF5FC66F67490745a4fa5dff59`.
  - Reality Module `0x8DFc…83dC`, using `RealityETH_ERC20-3.0` `0xdd34…2A43` with SAFE bonds.
  - Template 5, no arbitrator, 10,000 SAFE minimum bond, and a 3-day timeout, 5-day cooldown and 7-day expiration.
  - RealityVetoModule `0x4210…449b`, with the SEF veto Safe as `VETOER`.
  - `rewards.safenet-gov.eth`, with resolver `0xF291…AC15` and `contenthash` = `bafybeiczeo7uiupwte7dfa3yaus6dogwauxbookpvcgmxebbga5jtp7afq`.
  - `CumulativeMerkleDrop` `0xe513…20f2`, owned by the Governance Safe, with root `0x6689…fdef`.

  The tooling reads all of these from chain rather than hard-coding them.

- The Aegis consensus deployment (address and `CONSENSUS_START_BLOCK`) and the Aegis event ABIs are provided by the Aegis update work, not by this epic.
- The owner handover of the Governance Safe and its SAFE funding are completed by their dedicated tasks before the first distribution executes. The export only warns about the balance.
- The Zodiac `proposalId` is the package CID as a CIDv1 base32 string, and routine distributions need no Snapshot vote.
- Byte-for-byte reproducibility holds for the same commit, the same `package-lock.json` and Node.js 24. Verifiers check out the recorded commit.
- Sanctions screening against the UN/EU/UK/SECO/OFAC lists is already applied at every tree rebuild (#79). This epic only pins its inputs.
- The existing `cmd:rewards --record` and `cmd:kyc` flows stay available as an SEF fallback, gaining only the settlement window and the `--transactions` output directory.
- Events at exactly `toTimestamp` are counted by the existing inclusive `≤` conditions. This epic does not change period-boundary semantics; it only makes them reproducible.
