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
| Deterministic export and independent verification | 1–9, 12, 14a, 15, 16 |
| Deterministic transaction-bundle generation | 11, 13 |
| IPFS bundle and release publication | 10, 15, 18 |
| Daily indexing and cadence-aligned distribution runs | 17, 18 |
| Sanctions screening (already done in #79) | 9 (pinning) |
| Operator documentation for the permissionless flow | 19 |

The work breaks down into:

1. **Drop `updatedAt` from the Merkle DB index.** The pinned rewards DB no longer has it, and the current schema requires it.
2. **Allow the Beta → Aegis gap.** A one-off exception to the contiguous-period check for the week between the two programs.
3. **Move transaction bundles out of the rewards directory.** The rewards DB no longer contains `transactions/`.
4. **Root `MerkleDb` at a rewards directory** (refactor). The rewards DB is now a standalone IPFS directory.
5. **Block-at-timestamp lookup.** Find the consensus block that a period's settlement is measured from.
6. **Settlement window for sentinel reveals** and
7. **Settlement window for transaction attestations.** Make every reward query a pure function of chain history up to a fixed settlement point (48 consensus blocks after the period ends), so the result no longer depends on how far a database happens to be indexed.
8. **KYC file.** Add `data/kyc.json`, holding the KYC threshold and the KYC-approved accounts. SEF edits it manually, and it is seeded with the end-of-Beta threshold and approvals.
9. **Pinned sanctions snapshots.** Use the dated `data-YYYY-MM-DD` releases of `sanctions-address-lists` instead of the moving `latest` release.
10. **IPFS packing.** Deterministic UnixFS/CAR packing and verified unpacking, in pure JS.
11. **Governance Safe transactions.** The batched call the Governance Safe executes, its Zodiac transaction hash, and the Reality.eth question ID.
12. **Previous rewards DB resolution.** ENS `contenthash` → CID → verified CAR → directory, cross-checked against the onchain Merkle root.
13. **Action bundles.** Safe Transaction Builder JSON files for proposing, answering **Yes** and executing.
14. **Canonical JSON** (14a).
15. **Export pipeline, release assets and `cmd:export`.**
16. **`cmd:verify`:** re-derive the distribution and check the onchain proposal.
17. **Daily indexing Action.**
18. **Distribution Action.**
19. **Operator runbook.**
20. **Cleanup.** Remove this specification file.

Phases 1–14a are implemented. Of the remaining phases, 15a, 15b, 15c, 15d, 16a and 17a are independent of each other and can be developed in parallel. See [Implementation Phases](#implementation-phases) for the full dependency graph.

**Out of scope:**

- CLI commands that _send_ the propose, answer/challenge and execute transactions, or that inspect bond and answer state (struck from the deliverables). `cmd:verify` only checks that a matching proposal exists. Instead, every release ships Safe Transaction Builder bundles for the three actions. Any Safe can load them, an EOA can decode them, and the runbook covers challenges and timing checks.
- **IPFS pinning.** The epic produces the CAR and CID and mirrors them as release assets. Pinning is a separate community action, and CC is expected to pin.
- The Safe, oracle, modules, question template, ENS name, funding and ownership transfers come from the governance setup.
- The reward methodology itself comes from the separate _Update validator rewards scripts_ task, except for the Aegis validator budget constants, which Phase 2a sets. Sentinel rewards are already implemented (`Safenet.sentinelRewards`). See [Program parameters](#program-parameters).
- **Historic or post-execution verification.** `cmd:verify` only verifies the distribution on top of the currently ENS-pinned rewards DB. A way to name an older previous rewards DB can be added later if needed.
- **Database migrations.** Aegis changed the database schema, and indexing restarts from a new database at the Aegis consensus deployment block.

---

## Architecture Decision

### A distribution is a function of (pinned rewards DB, chain history, versioned inputs)

Distributions are **cumulative**: every rewards DB contains the full proof set for every account, and rewards DB _N_ is derived from rewards DB _N − 1_ plus the chain history of period _N_. The existing `MerkleDb` already does exactly this over a directory. The export command reuses it unchanged, against a working copy of the previous rewards DB, and the result is the new package. No new accounting code is written.

```
ENS contenthash ─► CID ─► verified CAR ─► previous rewards DB ─┐
chain history ≤ settlement ────────────────────────────────────┼──► Safenet.rewards + sentinelRewards ──► MerkleDb.distribute ──► package dir
src/distribution/kyc.json ─────────────────────────────────────┤                                                                 │
sanctions (data-YYYY-MM-DD) ───────────────────────────────────┘                                         IPFS pack (fixed params) ◄┘
                                                                                                                      │
                                                                                                CID = proposalId = next ENS contenthash
                                                                                                                      │
                                                                                      Governance Safe transaction + action bundles
```

There is no manifest. Every input is either onchain, a constant, or versioned in this repository, so verification is local re-derivation against onchain data only. `cmd:verify` fetches the previous rewards DB, builds the new Merkle DB through the same export pipeline, re-derives the Governance Safe transaction, and checks that the Reality Module holds a proposal with exactly that transaction. The transaction's `setContenthash` call embeds the package CID and its `setMerkleRoot` call the Merkle root, so a match implies that the package is byte-identical. `cmd:verify` reads no release asset. It prints a summary of the re-derived distribution (amounts, the stake versus commission split, forfeited sentinel grants, new KYC approvals).

The export has no reward overrides. The validator budget is always the Aegis default measured against the previous rewards DB (Phase 2a), the sentinel grant is always prorated over the period, and `minPayout` is always 0, so every export can be verified.

The previous rewards DB is never chosen by the operator. The export reads the `contenthash` of `rewards.safenet-gov.eth` and fetches that CID, verifying every block against it. It then requires the fetched `latest.json` Merkle root to equal `CumulativeMerkleDrop.merkleRoot()`. The two canonical references must agree. If they don't (for example, between the `setMerkleRoot` and `setContenthash` executions of a proposal), the export refuses to run. So the chain of rewards DBs always extends the DAO-controlled state.

Today the ENS record points to `bafybeiczeo7uiupwte7dfa3yaus6dogwauxbookpvcgmxebbga5jtp7afq`, and its `latest.json` root is `0x6689…fdef`, matching the drop. Every package has the same layout as that rewards DB.

`cmd:verify` resolves the previous rewards DB the same way: the ENS `contenthash` and the drop's root at the latest block, which covers verifying a pending proposal. The period it verifies is the two weeks after that rewards DB's `rewardsUntil` (with the Beta → Aegis exception). Historic or post-execution verification is out of scope for now.

### Verification checks the proposal onchain

The Reality Module stores only transaction **hashes** until execution: `addProposal(proposalId, txHashes)` builds the question `proposalId ␟ txHashes` and stores `questionIds[keccak256(question)]`. So `cmd:verify`:

1. re-derives the package CID and the batched Governance Safe transaction, and its Zodiac hash with nonce 0;
2. finds every question for the CID: the module's `ProposalQuestionCreated(questionId, proposalId)` events whose indexed `proposalId` topic is `keccak256(cid)`, from the last Ethereum block at or before `settlementTimestamp` (no proposal for the package can be older) to the latest block;
3. classifies each question by its text, read from the oracle's `LogNewQuestion` event for that question ID: **matching** if it equals `buildQuestion(cid, [hash])`, **different** otherwise. A re-asked question (nonce > 0) of the same proposal is still matching.

The outcome:

- **No question for the CID:** "no proposal yet". It prints the derived CID, the transaction hash and the summary, and exits 0.
- **Only matching questions:** verification passes. It prints the current one (`module.questionIds(keccak256(question))`), so answerers can check that it is the question they answer, and `executedProposalTransactions(keccak256(question), hash)`, so it also says whether the proposal has executed.
- **Any different question:** verification fails (non-zero exit), whether or not a matching one also exists, so the team has to react. It still prints the matching question, if there is one, and lists the different ones, which answerers should answer **No**.

The verifier passes no proposal or question argument: the re-derivation alone names the CID and the question. The governance configuration matters only through the module address and the ENS resolver, which the transaction targets; the bond, template and timeouts are not compared.

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

- **The rewards bundle** (the "rewards DB", or "the package" in the rest of this plan) is the IPFS bundle of the Merkle DB contents after the distribution. It is a UnixFS directory whose root is the **CID**, and it contains only `latest.json` (with the Merkle root) and the full cumulative `proofs/` tree, exactly the layout of the currently pinned rewards DB. It holds everything needed to claim, and, together with the previous rewards DB, everything needed to verify. It is mirrored as a CAR file in the GitHub release and pinned by CC or anyone else.
- **The transaction bundles** are the Governance Safe transactions that the Zodiac proposal executes, and the three Safe Transaction Builder bundles for proposing, answering and executing. They are _about_ the rewards bundle: each one references its CID and Merkle root. They are never written into the rewards directory.
- **The release** is the GitHub Release that carries both, plus the CID, the Merkle root and checksums.

One CID is used in three places. It is the IPFS root of the rewards bundle. It is the Zodiac `proposalId`, so the Reality.eth question is about that dataset. And the Governance Safe writes it into the `contenthash` of `rewards.safenet-gov.eth` when the proposal executes, so the ENS record keeps pointing to the latest rewards DB, alongside the onchain Merkle root. The transaction bundles contain the CID (in `setContenthash`, `addProposal` and so on), so they must stay outside the rewards bundle. They are deterministic functions of the CID, the Merkle root, the funding amount, the settlement timestamp and the onchain governance configuration. `cmd:verify` re-derives the Governance Safe transaction and checks it against the module.

### One batched Governance Safe transaction

The proposal is a single Zodiac transaction (Phase 11b): a `delegatecall` (`operation = 1`) from the Governance Safe to the canonical `MultiSendCallOnly`, which runs three calls in this order, each with `operation = 0`:

1. `SAFE.transfer(cumulativeMerkleDrop, additionalAmount)`. Funding comes first, so the drop always holds enough tokens for its root.
2. `CumulativeMerkleDrop.setMerkleRoot(root)`.
3. `PublicResolver.setContenthash(namehash("rewards.safenet-gov.eth"), 0xe301 ‖ CID)` (ENSIP-7).

The update is atomic, so the onchain root and the ENS `contenthash` never disagree because a proposal executed only partly. Calls are encoded as raw `data`, because the Zodiac transaction hash commits to the exact calldata. `proposal.json` records the batched transaction and its three decoded calls, so answerers can review each call.

### Action bundles instead of send-transaction tooling

Each release contains three Safe Transaction Builder bundles that **any** Safe can execute:

| Bundle | Transactions |
| --- | --- |
| `propose.json` | `RealityModule.addProposal(CID, [txHash])` |
| `answer.json` | `SAFE.approve(oracle, minimumBond)`, `oracle.submitAnswerERC20(questionId, bytes32(1), 0, minimumBond)` |
| `execute.json` | `RealityModule.executeProposalWithIndex(CID, [txHash], MULTI_SEND_CALL_ONLY, 0, data, 1, 0)` |

- `answer.json` posts the initial **Yes** answer with the module's minimum bond. It reverts if anyone has already answered, because the oracle requires at least double the current bond (`max_previous = 0` is not checked; see the Phase 13 deviations). Challenges and counter-answers depend on live bond state, so the runbook covers them (at least double the current bond, and the timeout restarts).
- `questionId` is computed locally with nonce `0`, the same way the module derives it. The inputs are the template ID, opening time `0`, question text `CID ␟ txHash`, arbitrator, timeout, minimum bond, oracle and module. The value is checked against the module's `getQuestionId` view. The bundle is only valid for the first time the question is asked. If a proposal is marked invalid and re-asked, nonce `0` no longer applies and the runbook explains how to proceed.

### Configuration comes from the module, not from env

Only the module address, the ENS name and the IPFS gateway are configuration. Everything else the governance setup records is read back from chain at export time, all at one block. `cmd:verify` reads it the same way, but only the module address and the ENS resolver affect what it checks:

| Value | Source |
| --- | --- |
| Governance Safe | `module.avatar()` (and `target()`) |
| Reality.eth oracle | `module.oracle()` |
| Template, arbitrator, minimum bond | `module.template()`, `arbitrator()`, `minimumBond()` |
| Timeout, cooldown, expiration | `module.questionTimeout()`, `questionCooldown()`, `answerExpiration()` |
| Bond token | `oracle.token()` |
| ENS resolver, previous rewards DB | ENS registry `resolver(namehash(name))`, resolver `contenthash(node)` |

This follows "consume the verified active configuration" literally: if the governance setup changes the bond or the template, the next export picks it up.

### KYC threshold and approvals are versioned with the code

KYC has two inputs:

- **The threshold:** the payout amount at or above which a recipient's payout is withheld in `kycAmount` until they are approved.
- **The approvals:** the `"kyc": true` field on an account's entry in `proofs/`, next to `cumulativeAmount` and `kycAmount`.

Both come from `data/kyc.json` in this repository, which SEF edits manually through reviewed PRs (the repository is in the SEF org). The export uses the file's threshold for `distribute`, and applies the flag to every listed account before it, so any withheld `kycAmount` is released in the same tree rebuild as the period's payouts. There is no flag, workflow input or external lookup for either value. A verifier uses its own checkout's file, so verification only succeeds with the same file the export used; the file is coordinated through this repository.

Flags are sticky: removing an address from the file does not revoke an approval. The export refuses to run if any account flagged in the previous rewards DB is missing from `data/kyc.json`, so the file is always the complete list. To help answerers, `cmd:verify` lists the newly approved accounts, which `distribute` reports.

### Deterministic IPFS in JavaScript

The CID is computed in-process with `ipfs-unixfs-importer` and written as a CARv1 with `@ipld/car`, so a verifier needs nothing beyond `npm ci`. The import parameters are fixed constants: CIDv1 base32, `sha2-256`, raw leaves, fixed-size 256 KiB chunker, balanced layout, no directory sharding, no `mtime`/`mode` metadata, no wrapping directory. These are Kubo's `ipfs add -r --cid-version=1` defaults. The currently pinned rewards DB was produced that way: its `latest.json` is a raw leaf whose hash equals the file's SHA-256. As a self-check, the export re-packs the unpacked previous rewards DB and warns if the CID differs.

Fetching uses an IPFS trustless gateway (`?format=car`), configurable through `IPFS_GATEWAY_URL` and defaulting to a local node's gateway (`http://127.0.0.1:8080`, as served by Kubo). A CAR is verified block by block against the requested CID, so the gateway, a release asset or a local file can each be the source, and none of them needs to be trusted.

### Canonical JSON matches the pinned rewards DB

The currently pinned rewards DB uses tab indentation, recursively sorted keys and a trailing newline (`jq --tab --sort-keys`). Package files, JSON release assets and `data/kyc.json` use the same canonical form, with `bigint`s as decimal strings. Address arrays (`data/kyc.json` `accounts`) are sorted by the 20 address bytes, which is the same as a case-insensitive sort of the hex string. That is what the existing `sortByAddress` in `src/utils/sort.ts` already does, and it is the order the Merkle tree leaves already use.

### Release assets, not git, for data availability

Reward packages are published as **GitHub Release assets** of this repository. These are explicitly non-canonical mirrors, and the release notes say so. The reproducible SQLite event index uses GitHub Actions cache for incremental runs and workflow artifacts for downloadable results. Periodic long-term DB snapshots are stored manually. The canonical references remain the onchain Merkle root and the ENS `contenthash` set by the Governance Safe.

### Alternatives Considered

- **Cut late events off at `toTimestamp`** instead of using a settlement window. This is simpler, but it silently drops the reveals and attestations that straddle the boundary, which reverses a decision of the sentinel rewards epic. Rejected.
- **Per-item deadlines** (request or proposal block + 48). More precise, but they need a block number on every row and change the semantics for items well inside the period. Rejected in favour of one cutoff per period.
- **A settlement window in seconds** (e.g. 48 × 5 s). Gnosis block times are not exact, so it would drift from the block-based reasoning above. Rejected.
- **Require verifiers to index exactly to recorded boundary blocks.** This only works with a fresh database, while the daily snapshot is indexed past the boundary. Rejected.
- **Let the operator pick the previous rewards DB** (a `--previous` path, or the newest matching release). This adds a trust decision that the ENS record already makes, and lets an export silently build on the wrong state. For the export, `--previousCar` is kept only as a local _source_ for the CID the ENS record names, never as a choice of which CID. `cmd:verify` resolves the previous CID from chain the same way. Rejected.
- **KYC threshold and approvals as CLI or workflow inputs** (today's `--kycThreshold`). Every verifier would have to supply them again, and nothing would keep them in sync with the code. Rejected in favour of `data/kyc.json`.
- **Compute the CID with the Kubo CLI.** This adds a non-npm toolchain to every verifier, and the output would depend on the Kubo version. Kept only as a cross-check in a test. Rejected.
- **Three separate Zodiac transactions**, executed one by one. Splitting only works around block gas limits, which three calls are nowhere near, and a partial execution leaves the onchain root and the ENS `contenthash` disagreeing. Rejected in favour of one `MultiSendCallOnly` delegatecall (Phase 11b).
- **Raw calldata files for propose/answer/execute.** Replaced by Transaction Builder bundles, which any Safe can load directly.
- **Publish the SQLite index as release assets.** Rejected to reduce persistence machinery. The index is reproducible from onchain data; use `actions/cache` for incremental indexing, upload each result as a workflow artifact, and store periodic snapshots manually.
- **A manifest and per-recipient allocations in the package**, recording the inputs (governance configuration, parameters, sanctions hashes, generator commit, boundary blocks) next to `latest.json`. Everything they record is either onchain, a constant, versioned in this repository, or derivable from the diff with the previous rewards DB, and a byte-for-byte re-derivation checks all of it. They would also change the layout consumers know from the Beta rewards DB. Rejected in the redux.
- **Verify the release files byte for byte** (the CAR, `cid.txt`, `proposal.json`, the action bundles and `SHA256SUMS`). The onchain proposal is what executes, and a matching `setContenthash` CID already implies an identical package. The bundles also depend on governance values that the answer does not. Rejected in the redux.
- **Reward overrides on `cmd:export`** (`--totalRewards`, `--sentinelRewards`, `--minPayout`). An overridden export could only be verified by supplying the same overrides again. Rejected in the redux.
- **Re-index from genesis in every verification.** Too slow and RPC-expensive for every run. Offered as an opt-in `workflow_dispatch` input of the distribution Action instead.

---

## User Flow

None of these users needs SEF approval or write access to the repository. The one exception is the KYC process, in which SEF edits the threshold and approvals in `data/kyc.json`.

### Automated publisher (GitHub Actions)

```
daily     restore DB cache ─► cmd:index ─► save cache + upload DB artifact
cadence   restore DB cache ─► cmd:index ─► cmd:export ─┬─► (fresh runner) cmd:export, compare SHA256SUMS ─► gh release create rewards-<toTimestamp>
                                                       └─► release-asset artifact ──────────────────────┘
```

### Independent verifier

```sh
git checkout main && npm ci   # or any checkout with the same src/distribution/kyc.json
npm run cmd:verify            # the next distribution on top of the ENS-pinned rewards DB
```

```
Previous CID:       bafybeiczeo7… (rewards.safenet-gov.eth, root 0x6689… == merkleRoot())
Period:             2026-10-13 – 2026-10-27, settled at Gnosis block 43,112,907
Sanctions lists:    data-2026-10-26
Package CID:        bafybei…
Merkle root:        0x3f1c…
Distribution:       284,615.38 SAFE (validators 192,307.69, sentinels 92,307.69)
  validators        stake rewards 185,412.05, commission 6,895.64, unpaid 0.00
  sentinels         6 / 6 paid, 0.00 forfeited
New KYC approvals:  0
Transaction hash:   0x9b0e…
Proposal:           question 0x8e2a…, not executed
OK
```

If nothing has been proposed for the CID yet, it prints `Proposal: none yet` and exits 0. If any question for the CID proposes a different transaction, it prints the matching question (if any), then lists the others and exits non-zero:

```
Proposal:           question 0x8e2a…, not executed
Other questions:    0x51c7… proposes a different transaction for this CID: answer No
FAILED
```

### Proposer, answerer, executor (documented, no new tooling)

1. _Optional, anyone, outside this epic:_ pin the CAR (`ipfs dag import rewards-<t>.car`).
2. Load `propose.json` into the Transaction Builder of any Safe and execute it. This costs gas and any question fee, but no bond.
3. Load `answer.json` and execute it to answer **Yes** with the minimum bond. A challenger answers with at least twice the current bond, following the runbook.
4. Once the answer is final, the cooldown has elapsed and the answer has not expired yet, load `execute.json` and execute it.

### Page Layout

No pages are added; the CLI output above is the only interface.

---

## Tech Specs

### Program parameters

This epic does not change the reward methodology. It packages whatever the reward scripts compute. For reference, the Safenet Aegis proposal that the methodology tasks implement:

- **Validators:** ~5,000,000 SAFE over 12 months starting **Tuesday 2026-10-13**, distributed **every 2 weeks**. This matches the existing Tuesday-to-Tuesday `rewardsPeriod()` grid (2026-04-07 + 27 weeks).
- **Sentinels:** ~2,400,000 SAFE as grants to 6 genesis Sentinels (400,000 SAFE each per year). As the DAO proposal allows, the sentinel rewards period is collapsed into the two-week rewards period. Sentinel rewards are computed and distributed on the **same two-week period** as validator rewards, prorated by the period's duration (`sentinelRewardsAmount`).

There is therefore a single rewards period. Both programs are computed over the same `[fromTimestamp, toTimestamp]` and merged into one distribution, so every command takes one `--rewardPeriodStart`/`--rewardPeriodEnd` pair. This is how `cmd:rewards` already works.

**The Beta → Aegis gap.** The pinned rewards DB ends at `rewardsUntil = 2026-10-06`, and Aegis starts on 2026-10-13. `MerkleDb.distribute` rejects periods that are not contiguous, so it gets one hard-coded exception. It accepts `fromTimestamp = 2026-10-13` when `rewardsUntil = 2026-10-06`, and no other gap. No rewards are paid for the week in between.

**Amounts.** `cmd:export` has no overrides. The validator budget is `totalRewardsAmount` against the previous rewards DB (the Phase 2a Aegis catch-up), the per-sentinel grant is `sentinelRewardsAmount` prorated over the period, and `minPayout` is 0. Sanctioned and KYC-withheld payouts stay in `tokenTotal`, so the transfer to the drop funds them, as `MerkleDb` does today.

### Package layout (the CID root)

```
latest.json
proofs/<b0>/<b1>/<b2>/<b3>/<0xaddress>.json   # unchanged MerkleDb layout, cumulative
```

This is exactly the layout of the currently pinned rewards DB: `latest.json` has no `updatedAt` (Phase 1), there is no `transactions/` directory (Phase 3), and there is no other file. The export copies the previous rewards DB into a working directory and refuses anything outside this layout, such as a `.lock`, `transactions/` or a misplaced proof, rather than ignoring it.

### Release assets (outside the CID)

| Asset | Contents |
| --- | --- |
| `rewards-<t>.car` | CARv1 of the package, root = package CID |
| `cid.txt` | Package CID (CIDv1 base32), one line |
| `merkle-root.txt` | Merkle root (lowercase `0x` hex), one line |
| `proposal.json` | `proposalId`, `questionId`, the batched transaction (`to`, `value`, `data`, `operation`, Zodiac `hash`) and its three calls |
| `propose.json` | Transaction Builder bundle: `addProposal` |
| `answer.json` | Transaction Builder bundle: `approve` + `submitAnswerERC20` (Yes) |
| `execute.json` | Transaction Builder bundle: one `executeProposalWithIndex` |
| `SHA256SUMS` | `sha256sum` lines for all of the above, sorted by name |

`<t>` is the period's `toTimestamp`. JSON assets are canonical JSON. Every asset is a deterministic function of the package, the governance configuration and the settlement timestamp. They serve proposers, answerers and pinning; `cmd:verify` does not read them.

Transaction Builder bundles use `chainId: "1"`, `createdAt: settlementTimestamp × 1000`, raw `data`, and no `createdFromSafeAddress`, because any Safe may load them.

Zodiac transaction hashes use EIP-712 with domain `EIP712Domain(uint256 chainId,address verifyingContract)` = `{ 1, module }` and struct `Transaction(address to,uint256 value,bytes data,uint8 operation,uint256 nonce)`, with `nonce` 0 for the one batched transaction. They are computed locally with viem's `hashTypedData` and cross-checked against `module.getTransactionHash`.

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

`sanctions-address-lists` publishes dated snapshot releases (`data-YYYY-MM-DD`) alongside the moving `latest`. The export uses the **newest `data-*` release whose UTC day ended at or before `toTimestamp`**. Like the onchain oracle, which is evaluated at `toTimestamp`, this makes the offchain lists a function of the period too. `cmd:verify` re-resolves the release from the period end with the same rule. No hashes are recorded: the upstream repository uses GitHub immutable releases, so a release's assets cannot change once published. Both commands print the release they used. Following the resolved decision below, the GitHub release history is trusted exactly as much as this repository's own git history.

### New commands and flags

| Command | Purpose |
| --- | --- |
| `cmd:export` | Build a package and release assets for an explicit period on top of the ENS-pinned rewards DB |
| `cmd:verify` | Re-derive the distribution on top of the previous rewards DB and check that the Reality Module holds a proposal with exactly its Governance Safe transaction |
| `cmd:plan` | Print the next period after the ENS-pinned rewards DB, and whether it has settled, for the distribution Action |

`cmd:export` takes the following flags:

- No period flags. The period is derived from the previous rewards DB: the two weeks from `nextRewardsStart(previous.rewardsUntil)`, which keeps the Beta → Aegis gap. This one period covers both validator and sentinel rewards.
- `--previousCar <file>`, optional. It is a local source for the ENS-named CID; without it, the CAR is fetched from `IPFS_GATEWAY_URL`.
- `--out <dir>`, required, missing or empty. It receives the release assets only.

There is no `--totalRewards`, `--sentinelRewards`, `--minPayout` or `--kycThreshold` (see [Program parameters](#program-parameters)).

`cmd:verify` takes:

- `--previousCar <file>`, optional, a local source for the ENS-named previous CID.
- `--cid <cid>`, optional: fail unless the derived package CID equals it. The distribution Action uses it to tie `cmd:verify` to its export artifact.

The previous rewards DB is always the ENS-pinned one at the latest block, cross-checked against the drop's root, as in the export.

There is no period flag: the period is the two weeks after the previous rewards DB's `rewardsUntil`. There is no release, proposal or question argument. It exits non-zero when any question for the CID proposes a different transaction (even next to a matching one), or when `--cid` doesn't match (see [Verification checks the proposal onchain](#verification-checks-the-proposal-onchain)).

`cmd:rewards` and `cmd:kyc` take `--transactions <dir>` for their Safe transaction bundle, instead of writing it into the rewards directory.

`cmd:index` keeps its existing indexing behavior. Cache validation is out of scope. Index results are downloadable workflow artifacts; periodic long-term DB snapshots are stored manually.

### Configuration

| Variable | Description | Default in `.env.sample` |
| --- | --- | --- |
| `REALITY_MODULE_ADDRESS` | Zodiac Reality Module on the Governance Safe | `0x8DFc5Db2C83200Cf0cC84d7e3C441d7721ef83dC` |
| `REWARDS_ENS_NAME` | ENS name whose `contenthash` pins the rewards DB | `rewards.safenet-gov.eth` |
| `IPFS_GATEWAY_URL` | Trustless gateway that rewards DB CARs are fetched from (verified, so untrusted) | `http://127.0.0.1:8080` (local Kubo) |

These are arguments of the commands that read them (`cmd:export`, `cmd:verify`, `cmd:plan`), not of the base schema in `src/utils/args.ts`. `CUMULATIVE_MERKLE_DROP_ADDRESS` is reused. Everything else comes from the module or ENS (see above). `SETTLEMENT_BLOCKS` and the IPFS import parameters are constants, not configuration, because changing them changes the output. Nothing records the commit that built a release.

### GitHub Actions

Both workflows read `STAKING_RPC_URL` and `CONSENSUS_RPC_URL` from repository secrets.

`.github/workflows/index.yml` (daily and `workflow_dispatch`):

- Serialize indexing runs and grant only `contents: read`.
- Restore `safenet.db` with `actions/cache`, following `safenet-beta-data`: a unique run key and a shared restore prefix select the latest available database. On a miss, start empty and index from the configured deployment blocks.
- Run `cmd:index`, then let the cache action save the updated database after a successful run.
- Upload the resulting database as a workflow artifact using the repository's configured retention period. Periodic snapshots for longer-term storage are downloaded and saved manually. There are no indexing releases, asset rotation, or automatic historical recovery.

`.github/workflows/distribution.yml` runs on a weekly schedule and on `workflow_dispatch` (with an opt-in "verify from genesis" input; the period is always derived):

- **plan** job: `cmd:plan` reads the ENS-pinned CID and its `rewardsUntil`, and computes the next period as `[rewardsUntil, rewardsUntil + 2 weeks]`, with the one-off Beta → Aegis exception (`[2026-10-13, 2026-10-27]`). Exit cleanly if that period has not settled yet or already has a release. A release that already exists means a proposal is in flight. This makes the weekly schedule idempotent against the two-week cadence.
- **export** job: restore the DB cache (or start empty on a miss), then run `cmd:index` and `cmd:export`, from source after `npm ci`. The output depends only on the checkout, so running the published Docker image instead gives the same bytes. The previous CAR comes from the `IPFS_GATEWAY_URL` repository variable, which must point at a reachable trustless gateway; the runner has no local node. Release-asset CAR reuse is omitted to keep the workflow small. Upload the release assets and export summary as separate workflow artifacts.
- **verify** job: on a separate runner, run a fresh `npm ci`, restore the DB cache (or start empty on a miss), and run `cmd:verify --cid "$(cat cid.txt)"` with the artifact's `cid.txt`. Nothing has been proposed yet, so it reports "no proposal yet" and passes when the independently derived CID matches.
- **release** job: `gh release create rewards-<toTimestamp>` with the assets, and notes giving the CID, root, amount, sanctions release and new KYC approvals (from the `cmd:export` summary), the commit the workflow ran on (informational only), the Safe Transaction Builder instructions, and the non-canonical disclaimer. No environment protection, no required reviewers.

Steps that resolve a sanctions snapshot set `env: GITHUB_TOKEN: ${{ github.token }}` (Phase 9e).

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
- Sanctions: the snapshot-tag selection rule at the period boundary.
- IPFS:
  - the fixture directory CID equals a Kubo-computed constant.
  - input order does not change the CID.
  - a CAR round-trips to identical files.
  - a CAR with a tampered block, or a different root, is rejected.
- Previous resolution: an ENS `contenthash` decodes to the expected CID. A root mismatch between `latest.json` and `merkleRoot()` is refused. A previous rewards DB with any file outside `latest.json` and `proofs/` is refused.
- Transactions: the Zodiac hash and question ID for a fixed proposal equal vectors read from the deployed module. The `contenthash` encoding round-trips the current record `0xe30101701220…`.
- Export: two exports of a harness scenario are byte-identical.
- Verify, against module and oracle fakes:
  - a matching proposal passes and is reported executed or not;
  - a re-asked matching question is still matching;
  - no proposal reports "none yet" and exits 0;
  - a different question fails, both alone and next to a matching one, and the output names the matching and the different question IDs;
  - `--cid` with another CID fails, and a verifier with a different `kyc.json` derives another CID.

---

## Implementation Phases

Phases 1–14a are implemented:

```
1 (drop updatedAt) ───────────┐
3 (tx bundles out) ─► 4 ──────┼─► 14a (canonical JSON)
8 (KYC file) ─────────────────┤
9a ─► 9b ─► 9c (sanctions) ───┘
2 (Beta → Aegis gap) ─► 2a (Aegis budget)
5 (block lookup) ─► 6 ─► 7
10a (pack) ┬─► 11a ─► … ─► 11e ─► 13a ─► … ─► 13d
           └─► 10b (unpack) ─► 12a ─► 12b (previous)
```

Phase 13b also depends on Phase 3 for the pure `transactionBundle()`. Phases 9d (docs) and 9e (GitHub token) follow 9c.

The remaining phases build on them:

```
15a (sanctions cleanup) ──────────┐
15c (payouts) ────────────────────┤
15b (governance) ┬─► 15e (inputs) ┴─► 15f (package) ┬─► 15g (assets) ─► 15h (cmd:export) ┬─► 18a (cmd:plan) ───┐
15d (layout) ────┘                                  │                                   │                     │
16a (proposal lookup) ──────────────────────────────┴─► 16b (re-derivation) ────────────┴─► 16c (cmd:verify) ─┤
17a (index.yml) ───────────────────────────────────────────────────────────────────────────────────────────┴─► 18b ─► 18c ─► 19 ─► 20
```

The **Depends on** lines below are authoritative.

Phases 15a, 15b, 15c, 15d, 16a and 17a can all be developed in parallel.

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

- Phase 12b: the ENS registry's `resolver`, the resolver's `contenthash`, and the Cumulative Merkle Drop's `merkleRoot`.
- Phase 13b–13d: the Reality Module's `addProposal` and `executeProposalWithIndex`, `RealityETH_ERC20.submitAnswerERC20`, and ERC-20 `approve`.
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

Split into 12a and 12b during review to keep each PR small. Each sub-phase is its own commit, branch and PR. Phase 12 has no commit of its own.

### Phase 12a — Rewards DB fetching

**Depends on:** Phase 10b (CAR verification) **Files:** `src/distribution/previous.ts`, `src/distribution/previous.test.ts`, `src/utils/args.ts`, `.env.sample` **Estimate:** ~120 LOC, 4 files

Fetches a rewards DB by CID, without reading the chain. The CAR comes from `--previousCar` or `IPFS_GATEWAY_URL` (`?format=car`, default `http://127.0.0.1:8080`) and is unpacked with verification. The result is re-packed, with a warning if the CID differs, and `latest.json` is read. Adds `IPFS_GATEWAY_URL`.

### Phase 12b — Previous rewards DB resolution

**Depends on:** 12a, Phase 11a (`contenthash` decoding) **Files:** `src/abi.ts`, `src/distribution/previous.ts`, `src/distribution/previous.test.ts` **Estimate:** ~110 LOC, 3 files

Reads the `contenthash` for `REWARDS_ENS_NAME` and decodes the CID, fetches it with 12a, and requires `latest.json.merkleRoot == merkleRoot()`. Adds the ENS registry `resolver`, resolver `contenthash` and drop `merkleRoot` ABI entries.

### Phase 13 — Action bundles

Split into 13a–13d during review to keep each PR small. Each sub-phase is its own commit, branch and PR, and Phase 13 has no commit of its own. Each sub-phase adds only the ABI entries its own code uses.

### Phase 13a — Shared governance test vectors

**Depends on:** Phase 11e **Files:** `tests/harness/governance.ts`, `src/distribution/transactions.test.ts` **Estimate:** ~100 LOC moved, 2 files

Moves the mainnet governance test vectors out of `transactions.test.ts` into a test-only module that the action bundle tests share. This is a refactor only, with no behaviour change.

### Phase 13b — `propose.json`

**Depends on:** 13a, Phase 3 **Files:** `src/abi.ts`, `src/distribution/actions.ts`, `src/distribution/actions.test.ts` **Estimate:** ~80 LOC, 3 files

`proposeBundle`, which calls `RealityModule.addProposal(CID, [txHash])` through the pure `transactionBundle()` from Phase 3. Adds the `addProposal` ABI entry.

### Phase 13c — `answer.json`

**Depends on:** 13b **Files:** `src/abi.ts`, `src/distribution/actions.ts`, `src/distribution/actions.test.ts` **Estimate:** ~70 LOC, 3 files

`answerBundle`: `SAFE.approve(oracle, minimumBond)`, then a Yes `oracle.submitAnswerERC20`. Adds the ERC-20 `approve` and `submitAnswerERC20` ABI entries.

### Phase 13d — `execute.json`

**Depends on:** 13c **Files:** `src/abi.ts`, `src/distribution/actions.ts`, `src/distribution/actions.test.ts` **Estimate:** ~70 LOC, 3 files

`executeBundle`, a single `executeProposalWithIndex` for the batched transaction, plus `actionBundles`, which returns all three bundles keyed by asset stem. Adds the `executeProposalWithIndex` ABI entry.

### Phase 14a — Canonical JSON

**Depends on:** Phases 1, 4 **Files:** `src/utils/json.ts`, `src/utils/json.test.ts`, `tests/fixtures/canonical/**` **Estimate:** ~80 LOC, 2 files + fixtures

Canonical JSON: recursively sorted keys, tab indentation, a trailing newline, and `bigint`s as decimal strings. It reproduces the currently pinned `latest.json` and `proofs/` byte for byte. `writeJsonFile` writes canonical JSON, so `MerkleDb` and every other JSON output become canonical.

Phases 14b (manifest schema), 14c (`allocations.json`) and 14d (package assembly) were dropped in the redux, and Phase 14 has no other sub-phase. See [Redux (after 14a)](#redux-after-14a).

### Phase 15 — Export

Split into 15a–15h before implementation, to keep each PR small. Each sub-phase is its own commit, branch and PR, and Phase 15 has no commit of its own. Each sub-phase adds only the ABI entries its own code uses.

### Phase 15a — Sanctions and manifest leftovers

**Files:** `src/data/sanctions.ts`, `src/data/sanctions.test.ts`, `src/safenet.ts`, `src/distribution/previous.ts`, `src/distribution/previous.test.ts`, `src/distribution/ipfs.ts`, `src/distribution/ipfs.test.ts`, `src/distribution/transactions.ts`, `README.md`, `AGENTS.md` **Estimate:** ~80 LOC, mostly removals, 10 files

A cleanup with no new behaviour. `pinnedSanctionedAccounts(period)` drops the `expected` argument and the per-source SHA-256, and returns `{ accounts, release }`. Doc comments, test names and docs that describe the manifest go, as does the `previous.test.ts` case that accepts a package with `manifest.json` and `allocations.json`.

### Phase 15b — Governance configuration

**Depends on:** Phases 11d, 12b **Files:** `src/abi.ts`, `src/distribution/governance.ts`, `src/distribution/governance.test.ts`, `src/distribution/previous.ts`, `src/distribution/previous.test.ts` **Estimate:** ~120 LOC, 5 files

`governanceConfiguration(client, { module, ensName, blockNumber? })` reads the module's config getters, `oracle.token()` and the ENS resolver at one block, and refuses a module whose `avatar` and `target` differ or a name with no resolver. `resolvePreviousRewardsDb` gains an optional `blockNumber`, so both read the same state. Reference: `permissionless/15a`.

### Phase 15c — Shared payout flattening

**Files:** `src/safenet.ts`, `src/cmd/rewards.ts`, `tests/harness/scenario.ts`, `tests/sentinel-rewards.test.ts` **Estimate:** ~50 LOC, 4 files

A refactor with no behaviour change. The flattening from `RewardSplit` to `Payout` moves out of `cmd:rewards` into a shared `distributionPayouts`, and the harness gains `createTestParameters`, so the export can reuse both. Reference: `permissionless/15c`, without the `allocations.test.ts` change.

### Phase 15d — Rewards DB layout

**Depends on:** Phase 12a **Files:** `src/distribution/package.ts`, `src/distribution/package.test.ts` **Estimate:** ~80 LOC, 2 files

`copyRewardsDb(from, dir)` copies a rewards DB into a missing or empty working directory. It checks the whole layout first: `latest.json` and `proofs/<b0>/<b1>/<b2>/<b3>/0x<address>.json` only, with each byte directory matching the address, and anything else, such as a `.lock`, `transactions/` or a `manifest.json`, is refused with the target untouched. Reference: `copyRewardsDb` in `permissionless/14d`, without the manifest and allocations handling and without `writePackageFiles`.

### Phase 15e — Export inputs

**Depends on:** 15b, 15d, Phase 2a **Files:** `src/distribution/export.ts`, `tests/export.test.ts` **Estimate:** ~120 LOC, 2 files

`exportInputs(config, dir)`, the first half of the pipeline: check that the staking chain is chain 1, read one block number, read the governance configuration and resolve the previous rewards DB at that block, assert that both report the same ENS resolver, copy the previous rewards DB into `dir`, derive the period as the two weeks from `nextRewardsStart(previous.rewardsUntil)`, and compute the default amounts for it against the copy. There are no overrides. Reference: `permissionless/15d`, without the overrides.

### Phase 15f — Export package

**Depends on:** 15a, 15c, 15e, Phases 7, 9c, 13d **Files:** `src/distribution/export.ts`, `tests/export.test.ts` **Estimate:** ~130 LOC, 2 files

`exportPackage(safenet, config, dir)`, the second half: the settlement, `rewards` with `minPayout` 0, `sentinelRewards`, the pinned sanctions, `distribute` with `kyc()`, `packDirectory`, `proposal()` and `actionBundles()`. It returns everything in memory, including the reward splits and the forfeited sentinel grants that `cmd:verify` prints, and has no CLI. Reference: `permissionless/15e`, without the manifest, the allocations and the generator.

### Phase 15g — Release assets

**Depends on:** 15f **Files:** `src/distribution/release.ts`, `src/distribution/release.test.ts` **Estimate:** ~80 LOC, 2 files

The pure `releaseAssets(export)`, which returns every asset as bytes keyed by name, plus `sha256Sums`, `carAssetName` and `writeReleaseAssets(dir, assets)`. Reference: `permissionless/15f`, without `manifest.json`.

### Phase 15h — `cmd:export`

**Depends on:** 15g **Files:** `src/cmd/export.ts`, `package.json`, `src/utils/args.ts`, `.env.sample`, `README.md` **Estimate:** ~100 LOC, 5 files

The command, with its arguments inline in the command file like the other commands: `--previousCar`, `--out`, `REALITY_MODULE_ADDRESS`, `REWARDS_ENS_NAME`, `CUMULATIVE_MERKLE_DROP_ADDRESS` and `IPFS_GATEWAY_URL`, which moves out of the base schema in `src/utils/args.ts`. The package is built in a temporary directory, and only the release assets land in `--out`. Reference: `permissionless/15g`, without the overrides and the generator.

### Phase 16 — `cmd:verify`

Split into 16a–16c before implementation, to keep each PR small. Each sub-phase is its own commit, branch and PR, and Phase 16 has no commit of its own.

### Phase 16a — Proposal lookup

**Depends on:** Phase 11e **Files:** `src/abi.ts`, `src/distribution/onchain.ts`, `src/distribution/onchain.test.ts` **Estimate:** ~120 LOC, 3 files

`findProposal(client, { module, oracle, fromBlock }, proposal)` searches the module's `ProposalQuestionCreated` logs for the CID from `fromBlock` and classifies each question by its `LogNewQuestion` text. It returns the matching questions (with the current `questionIds` value and `executedProposalTransactions`) and the different ones. Adds those ABI entries.

### Phase 16b — Re-derivation

**Depends on:** 16a, 15f **Files:** `src/distribution/export.ts`, `src/distribution/verify.ts`, `tests/verify.test.ts` **Estimate:** ~100 LOC, 3 files

`verifyProposal` runs `exportPackage` into a temporary directory, then `findProposal` from the Ethereum block at the settlement. It returns both, with the outcome: none yet, matching, or different (with the matching question, if any).

### Phase 16c — `cmd:verify`

**Depends on:** 16b, 15h **Files:** `src/cmd/verify.ts`, `package.json`, `README.md` **Estimate:** ~90 LOC, 3 files

The command takes `--previousCar`, `--cid` and the same configuration as `cmd:export`. It prints the summary from the User Flow, built from the `exportPackage` result. It exits non-zero when any question for the CID proposes a different transaction, even next to a matching one, or when `--cid` doesn't match.

### Phase 17 — Daily indexing Action

Cache validation was removed to reduce scope. The remaining daily indexing workflow is renumbered from 17b to 17a, with its own commit, branch and PR; Phase 17 has no commit of its own. Independent of every other phase.

### Phase 17a — Daily indexing workflow

**Depends on:** None **Files:** `.github/workflows/index.yml`, `README.md` **Estimate:** ~80 LOC, 2 files

The snapshot workflow described under [GitHub Actions](#github-actions).

### Phase 18 — Distribution Action

Split into 18a–18c before implementation. Each sub-phase is its own commit, branch and PR, and Phase 18 has no commit of its own.

### Phase 18a — `cmd:plan`

**Depends on:** 15h **Files:** `src/cmd/plan.ts`, `package.json`, `README.md` **Estimate:** ~80 LOC, 3 files

A JS command that resolves the ENS-pinned rewards DB and prints, as JSON, its CID, the next period (`nextRewardsStart`, plus two weeks) and whether that period's settlement block exists, for the plan job.

### Phase 18b — Plan, export and verify jobs

**Depends on:** 18a, 17a, 16c **Files:** `.github/workflows/distribution.yml` **Estimate:** ~110 LOC, 1 file

The plan, export and verify jobs. The verify job runs `cmd:verify --cid` with the artifact's `cid.txt` on a fresh runner. Releases are exported from source after `npm ci`. With no generator commit recorded, the published Docker image would produce the same bytes, so the choice does not matter.

### Phase 18c — Release job

**Depends on:** 18b **Files:** `.github/workflows/distribution.yml`, `README.md` **Estimate:** ~70 LOC, 2 files

`gh release create rewards-<toTimestamp>` with the release assets (the CAR, `cid.txt`, `merkle-root.txt`, `proposal.json`, the three bundles and `SHA256SUMS`) and notes built from the `cmd:export` summary.

### Phase 19 — Operator runbook

**Depends on:** Phases 16c, 18c **Files:** `docs/permissionless-distribution.md`, `README.md` **Estimate:** docs only

Covers how to:

- export a release, from source or the Docker image, and verify the pending proposal with `cmd:verify`.
- load the three bundles, and review the single delegatecall and its three calls in `proposal.json`.
- review new KYC approvals (the `cmd:verify` summary and the `src/distribution/kyc.json` history).
- challenge an answer: compute the next bond (at least double the current one), approve, and `submitAnswerERC20`. RealityETH only checks `max_previous` when it is greater than 0, so it is an optional front-running guard, not what makes a repeated answer revert (Phase 13 deviations).
- read the module getters for finality, cooldown and expiration.
- handle superseded proposals and questions that `cmd:verify` lists as different: answer **No** and let the answer expire.
- deal with the SEF `RealityVetoModule`. A veto blocks the whole update, with no partial execution.
- re-ask an invalidated question.
- for SEF, change the threshold or add approvals.

Pinning is mentioned only as something anyone may do with the CAR. The runbook points at the governance setup's deployment record for addresses and parameters.

### Phase 20 — Remove this specification

**Depends on:** Phase 19 **Files:** `epics/2026_10_20_permissionless_reward_distribution.md` **Estimate:** deletion only

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

- `Safenet.settlement({ toTimestamp })` is public and returns `{ boundaryBlock, settlementBlock, settlementTimestamp }`, so that Phase 15 can record the consensus boundary and settlement blocks in the manifest (the manifest was dropped in the redux; the export still uses the settlement). `src/safenet.ts` exports `SETTLEMENT_BLOCKS` (`48n`) and `Settlement`.
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
  - (The manifest was dropped in the redux, and Phase 15a removes `expected` and the hashes.)
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
- **The manifest records the repository** (the manifest was dropped in the redux, so this entry no longer applies). A release tag and its hashes only identify the lists within one repository, so `manifest.sanctions.offchain` gains `repository` (the configured `SANCTIONS_ADDRESS_REPO`, an `owner/name`).
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

### Phase 11d

- `buildQuestion(proposalId, txHashes)` keeps the module's `bytes32[]` signature, and a distribution passes a one-element array.
- `governanceCalls` and `governanceTransaction` now take `Pick<GovernanceConfiguration, "ensName" | "ensResolver">`.
- It is tested against the deployed module's `buildQuestion` and `getQuestionId` for the batched transaction at block 26247609, and against `getQuestionId("hello", 1)` at block 26247049. The configuration getters read at 26247049 agree with the question vectors at 26247609.

### Phase 11e

- `proposal.json` is `{ calls: [3 × { data, operation: 0, to, value }], proposalId, questionId, transaction: { data, hash, operation: 1, to, value } }`, with every key sorted. `transaction` is `multiSend(calls)` plus its Zodiac hash with nonce 0, and `questionId` is derived from `buildQuestion(proposalId, [hash])`.
- `zProposal` pins `transaction.to` to `MULTI_SEND_CALL_ONLY` and `transaction.operation` to 1, and each call's `operation` to 0. `transaction.value` is shape-only like every other value, and Phase 16 re-derives it. The `ProposalTransaction` type keeps `operation: 0 | 1`, and only the schema narrows it.

### Phase 12

These entries describe the behaviour of Phase 12 as a whole. The 12a and 12b entries below say how it was split and take precedence where they differ.

- `src/distribution/previous.ts` exports:
  - `resolvePreviousRewardsDb(client, { ensName, cumulativeMerkleDrop }, { previousCar?, ipfsGatewayUrl? }, dir, { withBackoff?, warn? })`, which returns `{ cid, merkleRoot, rewardsUntil, dir, ensResolver }`. The first three are the manifest's `previous` block, and `ensResolver` feeds `governance.ensResolver`, so Phase 15 doesn't need a second ENS read that could disagree;
  - `fetchRewardsDb(cid, source, dir, options)`, which fetches, verifies and unpacks a rewards DB by CID without reading the chain, for Phase 16;
  - `ensContenthash(client, { ensName, blockNumber? })`, which returns `{ cid, ensResolver }`, for Phases 16 and 17;
  - the lower-level `fetchCar` and `gatewayCarUrl`.
- The ENS registry address is the constant `ENS_REGISTRY` in `previous.ts`, next to `ensContenthash`, its only reader. Like `MULTI_SEND_CALL_ONLY`, it is a canonical deployment and not configuration.
- `IPFS_GATEWAY_URL` is an optional `ipfsGatewayUrl` in the base args schema, and `previous.ts` applies the default (`DEFAULT_IPFS_GATEWAY_URL`) the same way as `DEFAULT_SANCTIONS_ADDRESS_REPO`. Phase 15 may move it into the `cmd:export`/`cmd:verify` args. `REWARDS_ENS_NAME`, `REALITY_MODULE_ADDRESS` and `--previousCar` are parameters here, and Phase 15 adds them to the args.
- The gateway request is `<gateway>/ipfs/<cid>?format=car` with `Accept: application/vnd.ipld.car; version=1`, and one trailing `/` on the gateway is stripped. `order`, `dups` and `dag-scope` are left to the gateway's defaults, because unpacking accepts any block order and duplicates. Non-OK responses and network errors are retried with the backoff, then thrown as `failed to fetch '<url>': <status> <statusText>`. No auth header is ever sent.
- `resolvePreviousRewardsDb` reads one block number and reads the registry `resolver`, the resolver's `contenthash` and the drop's `merkleRoot` at that block, so both canonical references come from the same state.
- Errors:
  - `ENS name <name> has no resolver`;
  - `ENS name <name> has no contenthash`;
  - `decodeContenthash`'s own error for anything that isn't a package CID;
  - `rewards DB <cid> pinned by <name> has Merkle root <file>, but CumulativeMerkleDrop <addr> has Merkle root <onchain>`. The comparison ignores case.
- `latest.json` is read through `new MerkleDb({ root: dir }).index()`. A missing file or `rewardsUntil` throws, and `rewardsUntil` is returned as seconds. `manifest.json`, `allocations.json` and any other files are left in `dir` untouched for Phase 14 (the redux has no such files, and Phase 15d refuses them).
- The re-pack self-check runs inside `fetchRewardsDb`, so before the root check. A mismatch calls the injectable `warn`, which defaults to `debug("safenet:previous")`. The test provokes it with a CAR of dag-pb file leaves (`rawLeaves: false`), which `unpackCar` accepts but `packDirectory` never produces.
- `previous.test.ts` builds its fixtures with `MerkleDb.distribute` on top of a `latest.json` in the pinned Beta format, fakes the viem client with a `custom` transport (the Phase 5 pattern), and imports `namedAddress` and `parseSafe` from `tests/harness/utils.ts`.
- Real-data check, not committed: with the pinned Beta rewards DB packed as `previousCar`, resolving against mainnet returns `bafybeiczeo7…tp7afq`, root `0x6689…fdef` (equal to the drop's), `rewardsUntil` 1791244800 and resolver `0xF291…AC15`, with no re-pack warning. The gateway path was not exercised for real.

### Phase 12a

- 12a's code is the CID-based half of the unsplit Phase 12: `DEFAULT_IPFS_GATEWAY_URL`, `CAR_MEDIA_TYPE`, `RewardsDb`, `CarSource`, `Options`, `gatewayCarUrl`, `fetchCar` and `fetchRewardsDb`. Only the module header and two `Options` doc comments are narrowed to fetching.
- Two tests are new: one for a missing `latest.json` and one for a missing `rewardsUntil`. The tests make no RPC calls.
- The `.env.sample` comment for `IPFS_GATEWAY_URL` already mentions the ENS-pinned CID, which describes what the variable is for, even though the ENS read only arrives in 12b.

### Phase 12b

- `src/abi.ts` and `previous.ts` are identical to the unsplit Phase 12. The tests differ only by 12a's two refusal tests.
- 12a's gateway, local-CAR, package-files, retry, recovery, different-CID and re-pack tests go through `resolvePreviousRewardsDb` again, as in the unsplit phase, so they also check the ENS read, the resolver and the same-block reads. `fetchRewardsDb` keeps its own `describe`, with the happy path and the two refusal tests.
- Read-only mainnet re-check: the pinned CID, root `0x6689…fdef` (equal to the drop's), `rewardsUntil` 1791244800 and resolver `0xF291…AC15`, with no re-pack warning.

### Phase 13

These entries describe the behaviour of Phase 13 as a whole. The 13a–13d entries below say how it was split, and they win where they differ.

- **`max_previous = 0` is not what makes `answer.json` revert after an earlier answer.** RealityETH_ERC20-3.0 only checks `max_previous` when it is greater than 0. The bundle still reverts after any earlier answer, because `bondMustDoubleAndMatchMinimum` requires at least twice the current bond, which is already at least the minimum bond. This corrects the Action bundles bullet. The runbook (Phase 20) explains that a challenger's `max_previous` is an optional front-running guard.
- `execute.json` is a single `executeProposalWithIndex(proposalId, [hash], transaction.to, transaction.value, transaction.data, 1, 0)`, as in 11b. It overrides the Release assets row "3 × `executeProposalWithIndex`".
- `src/distribution/actions.ts` exports pure functions that return `TransactionBundle` objects. JSON is Phase 14's job. The functions are:
  - `proposeBundle(proposal, { module }, settlementTimestamp)`;
  - `answerBundle({ questionId }, { bondToken, minimumBond, oracle }, settlementTimestamp)`;
  - `executeBundle(proposal, { module }, settlementTimestamp)`;
  - `actionBundles(proposal, config, settlementTimestamp)`, which returns `{ answer, execute, propose }` keyed by asset stem.

  `ANSWER_YES` is `bytes32(1)`. The functions take a parsed `Proposal`, so Phase 16 can pass `zProposal.parse(…)` or a re-derived proposal.
- `settlementTimestamp` is a `bigint`, and `createdAt` is `Number(settlementTimestamp) * 1000`. Every bundle transaction has `value` `"0"`. In `execute.json`, `transaction.value` is a calldata argument, not ETH sent with the call.
- `answer.json` approves exactly `minimumBond` on `config.bondToken`. If the answerer has an internal Reality.eth balance, the oracle uses that first and the approval goes unused, which is harmless.
- `src/abi.ts` gains:
  - ERC-20 `approve`;
  - `REALITY_MODULE_ABI` (`addProposal`, `executeProposalWithIndex`, with `Enum.Operation` as `uint8`);
  - `REALITY_ETH_ERC20_ABI` (`submitAnswerERC20(bytes32 questionId, bytes32 answer, uint256 maxPrevious, uint256 tokens)`).

  The signatures were checked against `RealityModule.sol` and `RealityETH_ERC20-3.0.sol`.
- The mainnet test vectors moved from `transactions.test.ts` into the test-only `tests/harness/governance.ts`, which both test files import.
- Mainnet checks, read-only at block 26247971. An `eth_call` of the `propose.json` call succeeds, because the pinned CID has never been proposed with this hash. On a local anvil fork, with nothing broadcast:
  - propose, approve and answer all succeed;
  - a second equal answer reverts with "bond must be double";
  - executing early reverts with "question must be finalized";
  - executing after the timeout and the cooldown succeeds;
  - re-executing reverts.

### Phase 13a

- None. `tests/harness/governance.ts` and `transactions.test.ts` match the unsplit Phase 13, except that the header of `governance.ts` names only `transactions.test.ts` until 13b adds `actions.test.ts`.

### Phase 13b

- None. `proposeBundle` and the shared `createdAt` helper match the unsplit Phase 13. Only the module header is narrowed to proposing, and `REALITY_MODULE_ABI` holds `addProposal` alone.

### Phase 13c

- None. `answerBundle` and `ANSWER_YES` match the unsplit Phase 13. The ERC-20 `approve` and `REALITY_ETH_ERC20_ABI` (`submitAnswerERC20`) entries are added here.

### Phase 13d

- None. After 13d, `src/` and `tests/` are identical to the unsplit Phase 13.

### Phase 14a

- Canonical JSON is `canonicalJson(value): string` in `src/utils/json.ts`, next to `writeJsonFile` and `jsonReplacer`, not in `src/distribution/canonical.ts`. That way `MerkleDb` can use it without `src/merkledb/` importing from `src/distribution/`. Its tests are in `src/utils/json.test.ts`.
- Values are converted exactly as `JSON.stringify` with `jsonReplacer` converts them: `bigint` becomes a decimal string, `Date` an ISO string, and `undefined` fields are dropped. They are then printed with keys sorted recursively, tab indentation, `{}`/`[]` inline and a trailing newline. A top-level `undefined` throws.
- Keys are sorted in JavaScript string order (UTF-16 code units, the default `Array.prototype.sort()`). Every key the package uses is ASCII, so the pinned files are unchanged. Integer-like keys get no special order, so `"10"` sorts before `"9"`. Strings are escaped the way `JSON.stringify` escapes them. The code doesn't mention `jq`, which was only how the old data repository formatted its files.
- `writeJsonFile` writes canonical JSON instead of insertion-ordered JSON, so every JSON file the tool writes is canonical. That covers `MerkleDb`'s `latest.json` and proofs, `cmd:totals`, `cmd:participation` and the `--transactions` bundles. There is no separate canonical writer. Phases 14d and 15 write the manifest, allocations and release assets with `writeJsonFile` (the manifest and allocations were dropped in the redux).
  - The `--transactions` bundles now have sorted keys. Their content is unchanged, and the Safe Transaction Builder doesn't depend on key order.
  - `cmd:rewards --record` and `cmd:kyc` now write the rewards DB in the pinned format directly.
  - `network-info.json` and `validator-info.json` already had sorted keys, so they are unchanged.
- The fixture `tests/fixtures/canonical/` holds the pinned `latest.json` and the proof of `0x0484…2993`, copied unchanged.
- Real-data check, not committed: re-serializing all 209 `.json` files of the pinned rewards DB reproduces them byte for byte.
- Before 14a, `MerkleDb` did **not** write canonical JSON. Its keys came out in zod schema order (for example `tokenTotal` before `sentinelTokenTotal`, and `kycAmount` before `kyc`), so none of the 209 files it rewrote were canonical. It now writes canonical files with no change to `src/merkledb/index.ts`, and `tests/merkledb-index.test.ts` checks this. Real-data check, not committed: a `MerkleDb.kyc()` rebuild of the pinned rewards DB writes 209 of 209 canonical files. Their content differs only by the expected `sentinelTokenTotal`/`sentinelAmount` of `"0"`.
- `proposal()` no longer builds its keys in sorted order, which overrides the Phase 11e note saying it does. The `transactions` and `actions` tests serialize with `canonicalJson`.
- 14a also changes `src/distribution/transactions.ts`, its test, `src/distribution/actions.test.ts` and `tests/merkledb-index.test.ts`.

### Redux (after 14a)

A first implementation continued past 14a with a manifest, allocations, reward overrides and a generator commit (14b–14d, 15a–15h and an uncommitted 16a). It was dropped, and the plan restarts at Phase 15 with new numbering. References to Phases 14b–21 in the entries above use the old numbering. The old code survives for reference only, on the local branches `permissionless/14b` … `permissionless/15h` and `permissionless/16a-original`.

- **No manifest and no allocations.** The package is only `latest.json` and `proofs/`, exactly the layout of the pinned Beta rewards DB.
- **`cmd:verify` checks the proposal against onchain data only.** It fetches the previous rewards DB, builds the new Merkle DB through the export pipeline, re-derives the batched Governance Safe transaction and its Zodiac hash (nonce 0), and classifies every question for the CID (`ProposalQuestionCreated` logs, question text from `LogNewQuestion`) as matching `buildQuestion(cid, [hash])` or different. It passes with only matching questions, and with "no proposal yet" (exit 0), which lets the distribution Action run it with `--cid` before anything is proposed. Any different question for the CID fails it, even next to a matching one, and it prints the matching question (if any) and the different ones for answerers to answer **No**. A matching `setContenthash` CID implies a byte-identical package, so it reads no release asset: no `SHA256SUMS`, CAR, file or bundle comparison, and no Merkle DB diff. It prints a summary of the re-derived distribution from the `exportPackage` result. There is no `--release`, `--postExecution` or proposal argument, and no balance or pointer checks.
- **No reward overrides.** `cmd:export` has no `--totalRewards`, `--sentinelRewards` or `--minPayout`. It always uses the Phase 2a Aegis budget against the previous rewards DB, the prorated sentinel grant and `minPayout` = 0, so every export can be verified.
- **KYC** comes from `src/distribution/kyc.json`, coordinated through this repository. A verifier uses its own checkout's file.
- **Sanctions:** the snapshot is re-resolved from the period end with the existing rule. No hashes are recorded, because the upstream repository uses GitHub immutable releases. The `sanctions.offchain.repository` check went with the manifest.
- **No generator commit or version machinery:** no `generator` block, no `src/version.d.ts`, no `GIT_COMMIT`, no dirty-tree check. The release notes may mention the commit informally.
- **Previous rewards DB in `cmd:verify`:** always the ENS `contenthash` and the drop's root at the latest block, as in the export. The period is the two weeks after the previous `rewardsUntil`. Historic and post-execution verification are out of scope for now.
- **The proposal is unchanged** from 11b–11e and 13a–13d: one MultiSend delegatecall (transfer → `setMerkleRoot` → `setContenthash`), `proposal.json`, and the `propose`/`answer`/`execute` bundles. The release assets are those plus the CAR, `cid.txt`, `merkle-root.txt` and `SHA256SUMS`; `manifest.json` and `allocations.json` are gone.
- **Decisions from the first implementation that still apply:** sanctioned and KYC-withheld amounts stay funded (they count in `tokenTotal`), and `safeToken()` is read at `latest`.
- **Salvaged into the new phases** (reference branches):
  - governance configuration reading and `resolvePreviousRewardsDb`'s `blockNumber`: 15b (`permissionless/15a`);
  - `distributionPayouts` and `createTestParameters`: 15c (`permissionless/15c`);
  - the layout check and working-directory copy (`copyRewardsDb`), without manifest or allocations stripping: 15d (`permissionless/14d`);
  - the export pipeline (`exportInputs`, `exportPackage`), without the manifest, allocations, overrides and generator: 15e and 15f (`permissionless/15d`, `permissionless/15e`);
  - release assets (`releaseAssets`, `writeReleaseAssets`, `sha256Sums`, `carAssetName`), without `manifest.json`: 15g (`permissionless/15f`);
  - `cmd:export`, without overrides and generator: 15h (`permissionless/15g`);
- **Not salvaged:** the manifest schema (14b), `allocations.json` (14c), `writePackageFiles` (14d), the generator (15b, 15h), and the file comparison (`permissionless/16a-original`), because `cmd:verify` reads no release asset.

### Phase 15a

- `pinnedSanctionedAccounts` goes back to the internal shape from 9b:
  - `#fetchOffchainSource(tag, source)` returns the addresses, and `#offchainSanctionedAccounts(tag)` merges them. `sanctionedAccounts()` and the pinned call share it.
  - `OffchainSource` is module-private again, and `OffchainSanctions` is removed.
  - `PinnedSanctionedAccounts` is `{ accounts, release }`.
- `IPFS_PARAMETERS` is unexported and `IpfsParameters` is removed, because the manifest's `ipfs` block was their only consumer. The object stays as module-private documentation of the parameters, and its test went with the export.
- `fetchRewardsDb` still leaves extra files in `dir`. The epic's test case "a previous rewards DB with any file outside `latest.json` and `proofs/` is refused" is covered by 15d's `copyRewardsDb`, which both the export and `cmd:verify` go through.
- `previous.test.ts`:
  - "rejects a CAR of a different CID" uses a separately packed directory;
  - the missing-`latest.json` test packs `other.json` instead of `allocations.json`.

### Phase 15b

- Ported unchanged from `permissionless/15a`: `governance.ts`, `governance.test.ts`, the `src/abi.ts` entries (the nine module getters and `RealityETH_ERC20.token()`), and `resolvePreviousRewardsDb`'s optional `blockNumber` with its test. `previous.ts` and `previous.test.ts` differ from the reference only by the 15a cleanup.

### Phase 15c

- Ported unchanged from `permissionless/15c` (0d48a01), except the `src/distribution/allocations.test.ts` change, which is skipped because that file doesn't exist in the redux.

### Phase 15d

- Ported from `permissionless/14d` without the manifest and allocations handling, `writePackageFiles`, `MANIFEST_FILE`, `ALLOCATIONS_FILE` and `tests/harness/manifest.ts`. The only accepted entries are `latest.json` and an optional `proofs/`. Anything else, including `manifest.json` and `allocations.json`, is refused with `unexpected "<path>" in rewards DB`.
- The file stays `src/distribution/package.ts`, because the spec calls the rewards DB at the CID root "the package".
- Tests:
  - The `distribute` helper uses `distributionPayouts`.
  - The layout refusals target a missing directory and check that it is never created.
  - There is an extra refusal for `proofs` as a file.
  - The round trip (copy → `distribute` → `packDirectory` → `unpackCar` → copy) ends with a copy equal to the distributed directory.

### Phase 15e

- Ported from `permissionless/15d`, with these exceptions:
  - **No overrides:** the amounts are always `totalRewardsAmount` against `new MerkleDb({ root: dir })` and the prorated `sentinelRewardsAmount`. The override test is removed.
  - **No period argument:** `exportInputs(config, dir)` derives the period as `rewardsPeriod({ rewardPeriodStart: nextRewardsStart(previous.rewardsUntil) })`. That is the two weeks from the previous `rewardsUntil`, which keeps the Beta → Aegis gap. The period is returned as `ExportInputs.period`.
  - **Removed:** `ExportPeriod` and the continuity check, with its three refusal tests. Tests now cover the first Aegis period after Beta, and the two weeks after an Aegis rewards DB, including the budget catch-up.
  - **Wording:** the manifest wording on `ExportInputs.previous` is reworded.
- The derived period may not have ended or settled yet. The period's queries in `exportPackage` then refuse it, with `timestamp … is after the latest block` or `settlement block … does not exist yet`.

### Phase 15f

- Ported from `permissionless/15e` without the manifest, allocations and generator:
  - there is no `ExportParameters`, and `minPayout` is fixed at 0;
  - the staking boundary-block and consensus chain-ID reads are dropped, and so is `writePackageFiles`;
  - `safeToken()` is still read at `latest`.
- `exportPackage(safenet, config, dir)` takes the period from `exportInputs`: the two weeks after the previous rewards DB.
- `Export` is `ExportInputs` plus:
  - `settlement`, `payouts` (the merged `RewardSplit`s, before filters), `unpaid`, `forfeited` and `sanctionsRelease`;
  - the flattened `MerkleDb` update: `additionalAmount`, `merkleRoot` and `newlyApproved`;
  - `cid`, `car`, `dir`, `proposal` and `bundles`.
- A period that hasn't ended or settled is refused with `period <from> → <to> after rewards DB <cid> has not settled yet (<cause>)`, with the original error as `cause`. `blockAtTimestamp` now throws `TimestampAfterLatestBlockError`, and `Safenet.settlement` throws `SettlementBlockMissingError`. Both are exported, keep their messages, and are matched with `instanceof`. 15f therefore also changes `src/utils/blocks.ts` and `src/safenet.ts`.
- The test harness gains an optional `genesisTimestamp` on `MockChain`/`Scenario` (default 0, documented in `AGENTS.md`'s Block timing), so 15f also changes `tests/harness/chain.ts` and `tests/harness/scenario.ts`.
  - The end-to-end scenario starts an hour before `AEGIS_REWARDS_START`, with 1-hour consensus and 1-day staking blocks, so it spans the first Aegis period: about 400 blocks.
  - The expected amounts are the two-week Aegis values. Every payout is above the threshold and KYC-withheld, which keeps end-to-end KYC coverage.
  - Tests cover a period that hasn't ended and one that hasn't settled.

### Phase 15g

- Ported from `permissionless/15f` without `manifest.json`:
  - `releaseAssets` takes `Pick<Export, "car" | "cid" | "merkleRoot" | "period" | "proposal" | "bundles">`, and the CAR name and `merkle-root.txt` come from `period.toTimestamp` and `merkleRoot`;
  - the module doc describes the assets as mirrors for proposers, answerers and pinning, and no longer claims that `cmd:verify` compares them;
  - the test fixture is built from the governance vectors (`proposal(UPDATE, CONFIG)`, `actionBundles` at `toTimestamp + 240`), so `merkle-root.txt` is the proposal's own root;
  - the `writeJsonFile` byte-identity check uses `proposal.json`.

### Phase 15h

- Ported from `permissionless/15g` (e0c82e6), with these exceptions:
  - there are no `--rewardPeriodStart`/`--rewardPeriodEnd`, because the period is derived from the previous rewards DB (Phase 15e);
  - the command calls `exportPackage(safenet, args, <tmp>/package)`;
  - there are no `--totalRewards`, `--sentinelRewards` or `--minPayout`;
  - there is no `generator()` call or dirty-tree check, so the refusal of a non-empty `--out` is the only check before any RPC.
- The summary is built from the 15f `Export`. It prints:
  - the previous and package CIDs;
  - the derived period with its settlement block;
  - the Merkle root and the additional amount;
  - the validator rewards paid out of the budget, and the unpaid amount;
  - the sentinel total, with the per-sentinel grant and the forfeited amount;
  - the sanctions release;
  - the transaction hash and the question ID;
  - new KYC approvals.
- The README:
  - describes the derived period, including the Beta → Aegis gap, and that running before the period has settled fails with an error naming it;
  - says the same code, lockfile and `kyc.json` give byte-identical assets;
  - drops the period flags, overrides, manifest, generator commit and Docker git note.
- `args.ts` (with `ipfsGatewayUrl` moved out of the base schema), `package.json` and `.env.sample` are identical to e0c82e6.

### Phase 16a

- `findProposal` returns `{ blockNumber, matching, different }`. Every matching entry includes its observed `questionId`, exact `question` text, `currentQuestionId` from the module mapping and `executed` flag. Different entries include their observed ID and text.
- The configuration accepts an optional `blockNumber`, and a fourth options argument accepts `withBackoff`. By default, lookup reads the uncached latest block once and pins every log query and state read to that snapshot.
- Oracle logs are queried at each module event's block: the module asks the oracle before emitting `ProposalQuestionCreated` in the same call. Missing or ambiguous `LogNewQuestion` logs throw rather than report no proposal.
- Repeated question IDs are deduplicated; distinct re-asked IDs remain and match by exact text, regardless of the nonce-0 ID. Matching entries share the current mapping and execution flag, read once. Zero and invalidated current mappings are returned unchanged.
- A `fromBlock` beyond the snapshot returns empty results without issuing an inverted log query.
- The module log search is unpaginated, so a provider's block-range limit can reject a long search. RPC failures are retried and then thrown; they never produce an empty successful result.

### Phase 16b

- No shared export API changes were needed; `src/distribution/export.ts` is unchanged.
- `verifyProposal(safenet, config, options?)` returns `{ distribution, onchain, outcome }`. `distribution` is `Omit<Export, "dir">`, because the temporary package directory is removed before returning; all in-memory export data remains available. The outcome is `"none yet"`, `"matching"` or `"different"`, with any different question taking precedence while retaining both question lists.
- Optional `withBackoff` applies to the Ethereum settlement-boundary and proposal lookups. The boundary search starts at genesis, independently of the staking indexer's start block. A settlement before Ethereum genesis throws explicitly.
- Tests mock `exportPackage` to check orchestration, summary preservation and cleanup, and use the actual `findProposal` against raw viem logs. The existing export tests cover real re-derivation. Cleanup is checked on success and export, boundary or proposal lookup failure.
- CID mismatch handling remains in Phase 16c with the CLI flag.

### Phase 16c

- Added `tests/verify-cli.test.ts` beyond the listed phase files. It exercises the actual command and argument parser with mocked verification, covering exact token arithmetic and summary output, matching and different questions, CID checks, environment variables, unsupported flags and failure exit codes.
- Reporting stays local to `cmd:verify`; the export command's summary is unchanged. The verifier also prints the lookup's Ethereum block and every observed matching question ID, alongside the current mapping and execution flag. Cleared or invalidated mappings are printed unchanged.
- Sentinel reporting uses total earned rewards, the per-sentinel grant and forfeited amounts rather than inferring recipient counts. The summary identifies earned rewards before filters separately from the additional funding amount.
- The optional `--cid` is compared exactly with the derived CID's canonical string. A mismatch prints both values and `FAILED`, and sets exit code 1 after the summary and question lists. No proposal yet succeeds when the CID is omitted or matches.

### Phase 17a

- Cache validation was dropped at the user's request to reduce epic scope, and its uncommitted implementation and tests were removed. The remaining daily indexing workflow (formerly 17b) is renumbered to 17a. `cmd:index` remains unchanged, and no `--validate` or `--maxLag` flags are added.
- The user chose `actions/cache` for incremental indexing, following `safenet-beta-data`, plus a workflow artifact of each result. The event index is reproducible from onchain data; there is no release-based persistence or automatic historical recovery. Periodic long-term DB snapshots are stored manually. The daily workflow runs indexing without a separate cache-validation step.
- The daily schedule is 03:23 UTC, with manual dispatch also supported. Runs share the `index-snapshot` concurrency group and do not cancel an in-flight run.
- The workflow requires two repository secrets (`STAKING_RPC_URL`, `CONSENSUS_RPC_URL`) and four repository variables (`CONSENSUS_ADDRESS`, `CONSENSUS_START_BLOCK`, `SENTINEL_ORACLE_ADDRESS`, `SENTINEL_ORACLE_START_BLOCK`) for the actual Aegis deployments. Remaining settings come from `.env.sample`, with `DATABASE_FILE=safenet.db`. This avoids silently using the sample's sentinel placeholder or Beta consensus settings.
- The release restore, rotation and bootstrap implementation was removed. No helper scripts, dependencies or additional repository tests are introduced; offline workflow verification uses scratch files.
- The cache follows `safenet-beta-data`: `actions/cache@v4` stores `safenet.db` under `safenet-aegis-db-<run_id>` and restores with prefix `safenet-aegis-db-`. A cache miss starts indexing from an empty database. The workflow needs only `contents: read` and no GitHub release credentials or compression commands.
- `actions/upload-artifact@v7` uploads `safenet.db` directly as `index-snapshot-<run_id>-<run_attempt>`, using repository-default artifact retention. Operators periodically download and retain snapshots manually.

### Phase 18a

- `cmd:plan` prints canonical JSON with `{ previousCid, period: { fromTimestamp, toTimestamp }, settled }`. Timestamps are decimal strings. Use `npm run --silent cmd:plan` to suppress npm's banner; command stdout contains only JSON and diagnostics go to stderr.
- `settled` checks that the consensus settlement block exists, matching `Safenet.settlement`: the last block at or before the period end plus 48. A period that has not ended or settled returns `false` successfully; other RPC, configuration and previous-DB verification errors fail. Ethereum indexing may still need one more block to reach the consensus settlement timestamp.
- The command reuses verified previous-DB resolution, `nextRewardsStart` and `rewardsPeriod`, without constructing `Safenet`, opening `DATABASE_FILE`, indexing events, computing rewards or fetching sanctions. It needs ENS/drop configuration and the existing base arguments, but no Reality Module configuration. Ethereum chain ID is checked consistently with export.
- The temporary previous rewards DB is removed before successful output and on failure. Release-existence checks remain the workflow's responsibility in Phase 18b.
- Added `tests/plan-cli.test.ts` beyond the phase's three listed files to cover actual CLI parsing, JSON output, period derivation, settlement boundaries, failure propagation and cleanup.

### Phase 18b

- The distribution workflow runs Tuesdays at 04:23 UTC or by manual dispatch. The only dispatch input is `verifyFromGenesis`; there is no explicit period input because the commands derive the next period. Distribution runs are serialized without cancelling an in-flight run.
- Plan exposes `shouldRun`, `previousCid`, `periodStart`, `periodEnd` and `settled`. Unsettled periods and existing `rewards-<periodEnd>` releases skip successfully; only HTTP 404 means a missing release, while other lookup errors fail.
- All three jobs use fresh checkouts and Node.js 24 dependency installs. Export and verify restore the Aegis database cache independently with restore-only actions; they never save modified databases or share the exporter's database. `verifyFromGenesis` skips the verifier's cache restore. No indexing releases or validation checks are added.
- The gateway is required for every job's previous CAR resolution. Reusing a CAR from a matching rewards release is deferred to avoid release-search machinery; CAR verification against the ENS-pinned CID remains unchanged.
- Export requires the CAR filename for the planned period before handing off assets, so an ENS advance to another period fails rather than silently changing the planned release. Release assets and the export summary are retained as separate per-run workflow artifacts for Phase 18c. Verify independently re-derives the exported CID and exposes it as a job output.
- This phase adds only `.github/workflows/distribution.yml`, with read-only contents permission. It reuses the indexing workflow's deployment variables and RPC secrets, adds required `IPFS_GATEWAY_URL`, and supplies `GITHUB_TOKEN` for sanctions release listing. Publication remains Phase 18c. Offline workflow checks use scratch files rather than new repository test infrastructure.

### Phase 18c

- The release job depends on plan, export and verify, using GitHub's implicit success condition plus the plan's `shouldRun` output. Only the release job grants `contents: write`; it downloads this run's asset and summary artifacts without a checkout or dependency install.
- Notes copy the export summary verbatim, with an explicit explanation that no `New KYC Approval` entries means 0 new approvals. They include the workflow commit as informational metadata, the manual Safe Transaction Builder flow, and the non-canonical mirror disclaimer.
- Before publication, the job requires a nonempty verified CID equal to `cid.txt` and the CAR for the planned period. It uploads exactly the eight export assets with `gh release create`, targeting the workflow commit. Standard latest-release selection is retained, without overwrite or retry behavior.
- Answer instructions apply only to the original nonce-0 question without an earlier answer; re-asked questions and existing answers require manual handling. Finality, cooldown and answer expiration are checked live rather than hard-coded. The workflow publishes files but submits no onchain transactions.
- This phase changes only the workflow and README. Dependency, publication and notes checks use scratch scripts and a mocked GitHub CLI; no live workflow or release was run.

### Phase 19

- `docs/permissionless-distribution.md` is kept brief. It links to the README's command reference and to `AGENTS.md#distribution-inputs` rather than repeating them. The README's release-notes paragraph links to the runbook's Propose, Answer and Execute section.
- "Answer No and let the answer expire" is refined:
  - A final No never executes.
  - Only a final Yes is bounded by `answerExpiration()`, measured from finalization. It can be cleared afterwards with `markProposalWithExpiredAnswerAsInvalid`.
  - A superseded Yes must be vetoed or left to expire.
- A question finalized No, an expired Yes, or an `INVALIDATED` mapping can't be re-asked, because `addProposalWithNonce` requires an oracle result of `INVALIDATED`. The same CID and transaction therefore can't be proposed again, and a rejected period needs a changed export.
- `execute.json` keeps working after a re-ask, because it uses the module's current question mapping. Only `answer.json` is tied to nonce 0.
- The RealityVetoModule was read from its bytecode and getters, read-only, because its source wasn't available. It exposes `VETOER()` (`0xB6b5…2FaE`), `SAFE()`, `REALITY_MODULE()` and `vetoProposal(bytes32)`, and calls the module's `markProposalAsInvalidByHash`. The runbook names these, and the user confirmed that `vetoProposal` takes the question hash. The deployment record is an internal page, so the runbook names it without a link.
- The Phase 11b and 13 entries above say "the runbook (Phase 20)". Under the current numbering, the runbook is Phase 19.

## Open Questions and Assumptions

### Resolved decisions

1. **Settlement is 48 consensus blocks**, following the `safenet-monitor` worst-case attestation reasoning (see Architecture Decision).
2. **The previous rewards DB is the one pinned onchain.** It is the ENS `contenthash` of `rewards.safenet-gov.eth`, and it must agree with `CumulativeMerkleDrop.merkleRoot()`. There is no data repository dependency.
3. ~~**Proposal transactions run as three separate Zodiac transactions**~~ Superseded by Phase 11b: **the proposal is one `MultiSendCallOnly` delegatecall** batching transfer → `setMerkleRoot` → `setContenthash`.
4. **Safe Transaction Builder bundles for propose, answer and execute** replace dedicated send-transaction tooling.
5. **Stale proposals are handled socially.** While proposal _N_ is in flight, the ENS record still names _N − 1_, so the plan job sees that _N_'s period already has a release and skips. If _N_ is rejected, its release is deleted (or the period re-exported manually) and the next run rebuilds it. A superseded proposal must be answered **No** and is bounded by the module's answer expiration. No guard contract is added.
6. **GitHub history is trusted** for `sanctions-address-lists` snapshot releases to the same degree as for this repository's own history. The snapshot tag, re-resolved from the period end, is sufficient. Hashes are no longer recorded (redux), because the upstream releases are immutable.
7. **The rewards DB format is the currently pinned one:** `latest.json` and `proofs/` only, with no `updatedAt`, no `transactions/`, and (redux) no manifest or allocations.
8. **Validator and sentinel rewards share a single two-week rewards period.** The DAO proposal allows the sentinel rewards period to be collapsed into the two-week one. Sentinel grants are prorated over that period, so the CLI has no separate sentinel period option.
9. **The Beta → Aegis gap is a one-off, hard-coded exception** in `distribute`.
10. **There is no database migration code.** Aegis changed the schema, and indexing restarts from a new database at the Aegis consensus deployment block.
11. **The KYC threshold and approvals live in `data/kyc.json`** in this repository. SEF edits it manually, and verifiers use their own checkout's file (no `generator.commit`, see the redux). It is seeded with a 7,500 SAFE threshold (below 1,000 USDC, with a buffer for price movement) and the 13 end-of-Beta approvals.
12. **RPC providers are GitHub Actions secrets.**
13. **Pinning is not part of this epic.** The IPFS gateway is configurable and defaults to a local node (`http://127.0.0.1:8080`).
14. **Verification is re-derivation checked against the onchain proposal** (redux). There is no manifest, allocations or generator commit, and `cmd:verify` reads no release asset.
15. **The export has no reward overrides** (redux). Amounts are always the Aegis budget, the prorated sentinel grant and `minPayout` = 0.
16. **`cmd:verify` builds on the ENS-pinned rewards DB at the latest block** (redux), like the export, so it verifies the next distribution only. "No proposal yet" is not a failure.

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
- The owner handover of the Governance Safe and its SAFE funding are completed by their dedicated tasks before the first distribution executes. Nothing checks the balance; an underfunded transfer makes the execution revert.
- The Zodiac `proposalId` is the package CID as a CIDv1 base32 string, and routine distributions need no Snapshot vote.
- Byte-for-byte reproducibility holds for the same `src/distribution/kyc.json`, the same reward code, the same `package-lock.json` and Node.js 24. Nothing records the commit; verifiers use a current checkout, and the release notes may name the commit informally.
- Sanctions screening against the UN/EU/UK/SECO/OFAC lists is already applied at every tree rebuild (#79). This epic only pins its inputs.
- The existing `cmd:rewards --record` and `cmd:kyc` flows stay available as an SEF fallback, gaining only the settlement window and the `--transactions` output directory.
- Events at exactly `toTimestamp` are counted by the existing inclusive `≤` conditions. This epic does not change period-boundary semantics; it only makes them reproducible.
