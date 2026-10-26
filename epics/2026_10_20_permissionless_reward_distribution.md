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
9 (sanctions snapshots) ──────┘                            │
2 (Beta → Aegis gap) ─► 2a (Aegis budget) ─────────────────┤
5 (block lookup) ─► 6 ─► 7 ────────────────────────────────┼─► 15 (export) ─► 16 ─► 17 ─► 19 ─► 20 ─► 21
10 (IPFS) ─┬─► 11 (transactions) ─► 13 (action bundles) ───┤                                ▲
           └─► 12 (previous resolution) ───────────────────┘                                │
18 (daily index Action) ────────────────────────────────────────────────────────────────────┘
```

Phase 13 also depends on Phase 3 for the pure `transactionBundle()`. The **Depends on** lines below are authoritative.

Phases 1, 2, 3, 5, 8, 9, 10 and 18 can all be developed in parallel.

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

**Files:** `src/data/sanctions.ts`, `src/data/sanctions.test.ts`, `src/safenet.ts` **Estimate:** ~120 LOC, 3 files

Resolves the `data-*` tag for a period, fetches from it, and exposes the per-source SHA-256. `sanctionedAccounts()` keeps its current semantics when no period tag is requested.

### Phase 10 — Deterministic IPFS packing

**Files:** `package.json`, `package-lock.json` (generated), `src/distribution/ipfs.ts`, `src/distribution/ipfs.test.ts`, `tests/fixtures/ipfs/**` **Estimate:** ~230 LOC excluding the lockfile, 5 files + fixtures

Adds `ipfs-unixfs-importer`, `ipfs-unixfs-exporter`, `@ipld/car` and `multiformats`. Implements `packDirectory(dir) → { cid, car }` with the fixed import parameters, and `unpackCar(car, expectedCid, dir)`, which rejects any block whose hash does not match and any root other than `expectedCid`. Includes the Kubo cross-check vector.

### Phase 11 — Governance Safe transactions

**Depends on:** Phase 10 (CID type) **Files:** `src/abi.ts`, `src/distribution/transactions.ts`, `src/distribution/transactions.test.ts` **Estimate:** ~230 LOC, 3 files

Adds ABIs for:

- ERC-20 and the Cumulative Merkle Drop.
- the ENS registry, and the resolver (`setContenthash`/`contenthash`).
- the Reality Module: `addProposal`, `executeProposalWithIndex`, `getTransactionHash`, `getQuestionId`, and the config getters.
- `RealityETH_ERC20`: `submitAnswerERC20` and `token`.

Builds the three calls, the ENSIP-7 `contenthash` encoding and decoding, the Zodiac hashes, the question text and ID, and `proposal.json`. These are pure functions with no RPC.

### Phase 12 — Previous rewards DB resolution

**Depends on:** Phases 10, 11 (CAR verification, ENS ABIs) **Files:** `src/distribution/previous.ts`, `src/distribution/previous.test.ts`, `src/utils/args.ts`, `.env.sample` **Estimate:** ~180 LOC, 4 files

Resolves the previous rewards DB as follows:

- reads `contenthash` for `REWARDS_ENS_NAME` and decodes the CID.
- obtains the CAR from `--previousCar` or `IPFS_GATEWAY_URL` (`?format=car`, default `http://127.0.0.1:8080`), and unpacks it with verification.
- requires `latest.json.merkleRoot == merkleRoot()`.
- re-packs the result and warns if the CID differs.

Adds `IPFS_GATEWAY_URL`.

### Phase 13 — Action bundles

**Depends on:** Phases 3, 11 **Files:** `src/distribution/actions.ts`, `src/distribution/actions.test.ts` **Estimate:** ~150 LOC, 2 files

Builds `propose.json`, `answer.json` and `execute.json` from `proposal.json` and the governance configuration, using the pure `transactionBundle()` from Phase 3.

### Phase 14 — Package manifest and assembly

**Depends on:** Phases 1, 4, 8, 9 **Files:** `src/distribution/manifest.ts`, `src/distribution/package.ts`, `src/distribution/canonical.ts`, `src/distribution/package.test.ts` **Estimate:** ~260 LOC, 4 files

Covers:

- the manifest schema.
- canonical JSON (sorted keys, tabs).
- writing `allocations.json` and the manifest next to a `MerkleDb` output.
- copying a previous rewards DB, with or without a manifest, into a working directory without its manifest or allocations.

### Phase 15 — `cmd:export`

**Depends on:** Phases 2, 7, 12, 13, 14 **Files:** `src/cmd/export.ts`, `src/distribution/governance.ts`, `package.json`, `src/utils/args.ts`, `.env.sample`, `README.md` **Estimate:** ~250 LOC, 6 files

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

Re-exports from the manifest (including `previous.cid`) into a temporary directory and compares every file, the CID and every derived asset, printing a per-file diff.

### Phase 17 — Onchain consistency checks

**Depends on:** Phase 16 **Files:** `src/distribution/onchain.ts`, `src/cmd/verify.ts`, `README.md` **Estimate:** ~150 LOC, 3 files

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
