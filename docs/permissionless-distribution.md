# Permissionless Distribution Runbook

Anyone can export, verify, propose, answer and execute a reward distribution. The canonical rewards state is the Cumulative Merkle Drop's `merkleRoot()` together with the ENS `contenthash` of `rewards.safenet-gov.eth`; GitHub releases are non-canonical mirrors. This repository builds and verifies distributions and ships Safe Transaction Builder bundles, but it never sends onchain transactions.

Addresses and parameters come from the governance setup's deployment record, _Configure Safenet Governance Safe - Mainnet_. Only `REALITY_MODULE_ADDRESS`, `CUMULATIVE_MERKLE_DROP_ADDRESS` and `REWARDS_ENS_NAME` are configuration; the commands read everything else (the Governance Safe, oracle, bond token, template, bond and timings, and the ENS resolver) from the module and ENS. Always read timings and bonds live rather than copying them from the record.

## Export and Verify

Use Node.js 24+ and a checkout with the same reward code, `package-lock.json` and [`src/distribution/kyc.json`](../src/distribution/kyc.json) as the export you want to reproduce. Set up `.env` as in the [README](../README.md#setup), with the actual Aegis `CONSENSUS_ADDRESS`, `CONSENSUS_START_BLOCK`, `SENTINEL_ORACLE_ADDRESS` and `SENTINEL_ORACLE_START_BLOCK` (the sample's sentinel address is a placeholder), and an `IPFS_GATEWAY_URL` that serves the ENS-pinned CID.

```sh
npm ci
npm run --silent cmd:plan                                 # next period and whether it has settled
npm run cmd:export -- --out=./release                     # release assets for that period
npm run cmd:verify -- --cid="$(cat ./release/cid.txt)"    # independent re-derivation
```

All three commands resolve the previous rewards DB from the current ENS `contenthash`, verify its CAR against that CID and require its root to equal the drop's. The period is always the two weeks after it (with the one-off Beta → Aegis gap); there are no period or reward flags. Export and verify fail until the period has settled, which `cmd:plan` reports as `"settled": true`. `--out` must be missing or empty. See the [command reference](../README.md#cmdplan) for flags and output.

`--previousCar=<file>` replaces the gateway as the source of the previous rewards DB, but a CAR of any other CID is refused. Download the `rewards-<t>.car` asset of the previous release, or run `ipfs dag export <ENS-pinned CID> > previous.car` on a node that has it.

To run from Docker, build the image from the same checkout, because `kyc.json` is compiled into it:

```sh
docker build -t safenet-staking-scripts .
docker run --rm --env-file .env -v "$PWD/out:/out" safenet-staking-scripts export --out=/out/release
docker run --rm --env-file .env safenet-staking-scripts verify --cid="$(cat out/release/cid.txt)"
```

The container's `localhost` is not the host's, so use a gateway it can reach, or mount a CAR and pass `--previousCar`. A persistent `DATABASE_FILE` only saves indexing time (see [`cmd:index`](../README.md#cmdindex)); a verifier can use its own database or `:memory:`.

## Review

Run `cmd:verify` again after the proposal and before every answer. It rebuilds the package, re-derives the Governance Safe transaction and checks every Reality Module question for the derived CID. It reads no release asset.

| Output | Exit | Action |
| --- | --- | --- |
| `Proposal: none yet`, `OK` | 0 | Nothing proposed for this CID yet. Propose after review. |
| `Proposal: current question mapping <id>, executed` or `not executed`, `Matching Question: <id>` lines, `OK` | 0 | Every question for the CID proposes exactly the derived transaction. Answer the **current mapping**, not an older matching ID. |
| `Other questions: <id> proposes a different transaction for this CID: answer No`, `FAILED` | 1 | Answer **No** to each listed question (see [Superseded and Invalid Proposals](#superseded-and-invalid-proposals)), even next to a matching one. |
| `CID mismatch: expected <cid>, derived <cid>`, `FAILED` | 1 | Your checkout derives another package. Compare code, lockfile and `kyc.json`. |
| An error | 1 | Not verified. A period that has not settled fails here too. |

`OK` and `not executed` say nothing about answers, bonds or timing. Once a proposal executes, ENS points at the new rewards DB and `cmd:verify` moves on to the following period (and fails until that settles); there is no historic or post-execution verification.

Then review the summary:

- The period, the previous and package CIDs, the Merkle root, the `Additional Amount` transferred to the drop, the validator stake rewards, commission and unpaid budget, and the sentinel grants and forfeitures. Reward totals are before sanctions and KYC filters; withheld amounts stay funded in `Additional Amount`.
- `Sanctions Lists`: the `data-YYYY-MM-DD` snapshot release of the sanctions lists, the newest whose UTC day ended by the period end. `cmd:sanctions` uses the moving `latest` lists instead.
- `New KYC Approvals` and each `New KYC Approval` line: compare them with the reviewed history of `src/distribution/kyc.json` (`git log -p -- src/distribution/kyc.json`).

Finally review `proposal.json` from the release (check the downloads with `sha256sum -c SHA256SUMS`, and `cid.txt` against your derived CID). Its `proposalId` is the package CID, its `questionId` the nonce-0 question, and its `transaction` (with Zodiac `hash`, nonce 0) is a single zero-value **delegatecall** (`operation: 1`) to the canonical `MultiSendCallOnly`, `0x9641d764fc13c8B624c04430C7356C1C7C8102e2`. Its `calls` are the three batched calls, each `operation: 0`, in this order:

1. SAFE `transfer(CumulativeMerkleDrop, additionalAmount)`, present even when the amount is 0.
2. `CumulativeMerkleDrop.setMerkleRoot(merkleRoot)`.
3. The ENS resolver's `setContenthash(namehash(REWARDS_ENS_NAME), 0xe301 ‖ CID)`.

Decode them in the Transaction Builder or any ABI decoder, and check the targets, amount, root and CID against the summary. The batch is atomic: if any call reverts, nothing executes, so the root and the `contenthash` never disagree.

## Propose, Answer and Execute

Load the bundles into the Transaction Builder of **any** Safe on Ethereum mainnet; the Governance Safe executes the batch through its Reality Module. An EOA can decode the bundles and send the same calls with its own tooling.

1. **Propose:** `propose.json` calls `addProposal(CID, [hash])`. It costs gas, but no bond. Rerun `cmd:verify`.
2. **Answer Yes:** `answer.json` approves the module's `minimumBond` of the bond token to the oracle and calls `submitAnswerERC20(questionId, bytes32(1), 0, minimumBond)`. It only works for the original nonce-0 question with no answer yet; otherwise answer manually as in [Challenges](#challenges). The answering Safe needs the bond.
3. **Execute:** once the answer is final **Yes**, the cooldown has passed and the answer has not expired, `execute.json` calls `executeProposalWithIndex(CID, [hash], MultiSendCallOnly, 0, data, 1, 0)`. It uses the module's current question mapping, so it also works after a re-ask. Then check the module's execution flag, the drop's `merkleRoot()` and the ENS `contenthash`. The Governance Safe must hold the SAFE to transfer, or the execution reverts.

To check timing, read these getters (for example in Etherscan or the Transaction Builder's contract interaction), with `id` the current question mapping:

| Contract | Getters |
| --- | --- |
| Reality Module | `oracle()`, `minimumBond()`, `questionTimeout()`, `questionCooldown()`, `answerExpiration()`, `INVALIDATED()`, `buildQuestion(CID, [hash])`, `questionIds(keccak256(question))`, `getQuestionId(question, nonce)`, `executedProposalTransactions(keccak256(question), hash)` |
| Reality.eth oracle | `token()`, `getBestAnswer(id)`, `getBond(id)`, `getMinBond(id)`, `getTimeout(id)`, `getFinalizeTS(id)`, `isFinalized(id)`, `isPendingArbitration(id)`, `resultFor(id)` |

With `F = getFinalizeTS(id)`, execution requires `isFinalized(id)`, `resultFor(id) == bytes32(1)`, `getBond(id) >= minimumBond()`, and, at the block timestamp `now`:

```text
F + questionCooldown() < now                                  # cooldown
answerExpiration() == 0 || now <= F + answerExpiration()      # expiration, measured from F
```

Every new answer moves `F` to its own time plus the question's timeout, so read `getFinalizeTS(id)` live rather than computing it from the proposal time.

## Challenges

To counter a wrong answer, from any account holding the bond token:

1. Read `getBond(id)` as `B`, and check that the question is neither finalized nor pending arbitration. Use the current mapping as `id`, and `token()` and the oracle from the module.
2. Pick a bond `N >= 2 × B` in token base units (or `N >= getMinBond(id)` if nobody has answered). A **Yes** that should execute also needs `N >= minimumBond()`.
3. Call `approve(oracle, N)` on the bond token, then `submitAnswerERC20(id, answer, maxPrevious, N)` on the oracle, with `answer` **No** = `bytes32(0)` or **Yes** = `bytes32(1)`.
4. `maxPrevious` is an optional front-running guard: set to `B`, the call reverts if someone raised the bond first. The oracle only checks it when it is greater than 0, so `0` disables it. A repeated answer with an equal bond reverts because the bond must at least double, which is also why `answer.json` fails once anyone has answered.
5. The timeout restarts with every answer. Keep watching until the question is finalized.

## Superseded and Invalid Proposals

**Different or superseded questions.** Answer **No** to every question `cmd:verify` lists under `Other questions`, and to any proposal that a corrected distribution supersedes, then let it run out. A final **No** never executes. A final **Yes** stays executable until `answerExpiration()` after finalization, so a superseded Yes must be vetoed or left to expire; publishing a new release does not cancel it. After expiry, anyone can call `markProposalWithExpiredAnswerAsInvalid(keccak256(question))` on the module to clear it.

**Re-asking an invalidated question.** If Reality.eth finalizes the question as invalid (`resultFor(id) == INVALIDATED()`, all `ff`, which is not **No**), call the module's `addProposalWithNonce(CID, [hash], nonce)` with an unused `nonce > 0`, and check the new ID against `getQuestionId(question, nonce)`. `cmd:verify` still reports the re-asked question as matching. `answer.json` targets the nonce-0 ID, so answer the new ID manually as in [Challenges](#challenges); `execute.json` still works. A question finalized **No**, an expired **Yes**, or a module mapping set to `INVALIDATED()` (by the owner or by a veto) can never be re-asked, and the same distribution cannot be proposed again; a corrected one needs a new export.

**SEF veto.** The `RealityVetoModule` on the Governance Safe lets its `VETOER()`, an SEF Safe, call `vetoProposal(bytes32 questionHash)` with the proposal's question hash, which has the Governance Safe mark the proposal invalid on the Reality Module (`markProposalAsInvalidByHash`). Check the addresses against the deployment record before vetoing. A veto blocks the **whole** update, because it is a single transaction: the transfer, the Merkle root and the `contenthash` all stay unchanged, with no partial execution. It must land before execution, so the cooldown is the veto window, and it cannot undo an executed proposal.

## Automated Publication

The [distribution workflow](../.github/workflows/distribution.yml) exports, independently verifies and publishes `rewards-<periodEnd>` releases; see [`cmd:export`](../README.md#cmdexport) for its jobs and configuration. Its `plan` job skips periods that have not settled or already have a release, so while a proposal is in flight it does nothing. If a proposal is rejected, delete its release (this changes no onchain state) so the next run rebuilds the period, or export a replacement manually, and keep answering the rejected question **No**.

Pinning is not part of this tooling: anyone may pin a release's CAR, for example with `ipfs dag import rewards-<t>.car`.

## KYC Changes (SEF)

SEF changes KYC only through a reviewed PR to `src/distribution/kyc.json`, which every export and verifier reads (see [Distribution Inputs](../AGENTS.md#distribution-inputs)):

- `threshold` is a positive decimal amount of SAFE. Payouts at or above it to unapproved accounts are withheld in `kycAmount`.
- To approve an account, add its checksummed address in sorted position (by address bytes). Never remove one: approvals are sticky, and an export refuses to run while an account already approved in the rewards DB is missing from the file.
- Check the edit with `npx vitest run tests/kyc.test.ts`. The next export flags the new accounts before the period's payouts, releasing their withheld amounts in the same rebuild, and both `cmd:export` and `cmd:verify` list them as `New KYC Approval`.

Merge the change before the period's export, because exporters and verifiers must use the same file.
