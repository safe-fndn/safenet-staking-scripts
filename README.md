# Safenet Accounting

Scripts for indexing Safenet Beta consensus events and computing validator participation rates and SAFE reward payouts at the end of each accounting period.

> [!NOTE]
>
> Safenet is currently in Beta. The reward mechanism used in this repo is a proposal pending SafeDAO approval. Parameters and mechanics may change.

## Design Overview

Instead of loading all consensus events into memory at once, the scripts first index events into a local SQLite database, then compute accounting results from that cache. This provides a few benefits:

- Avoids the memory footprint of holding hundreds of thousands of events in memory at once.
- Seamlessly recovers from intermittent network errors while querying a node.
- Reduces RPC credit usage during development by avoiding redundant fetches.
- Allows accounting parameters to be tweaked between runs without re-indexing from scratch.

## Setup

**Prerequisites:** Node.js v24+, npm.

```sh
npm ci
```

Copy the sample environment file and fill in your values:

```sh
cp .env.sample .env
```

All scripts read configuration from environment variables (or from a `.env` file in the project root). The available variables are:

| Variable                         | Description                                                                                                           | Default in `.env.sample`                     |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `DEBUG`                          | Debug log filter. All logs are under the `safenet:` prefix.                                                           | `safenet,safenet:*`                          |
| `DATABASE_FILE`                  | Path to the SQLite database file for cached events. Use `:memory:` to disable persistence.                            | `:memory:`                                   |
| `STAKING_RPC_URL`                | RPC endpoint for the staking chain (Ethereum mainnet).                                                                | `https://mainnet.gateway.tenderly.co`        |
| `STAKING_BLOCK_PAGE_SIZE`        | Number of blocks to fetch logs for in a single RPC call on the staking chain.                                         | `100`                                        |
| `STAKING_ADDRESS`                | Address of the staking contract.                                                                                      | `0x115E78f160e1E3eF163B05C84562Fa16fA338509` |
| `STAKING_START_BLOCK`            | Block at which the staking contract was deployed.                                                                     | `24585750`                                   |
| `SANCTIONS_LIST_ADDRESS`         | Address of the Chainalysis sanctions list oracle.                                                                     | `0x40C57923924B5c5c5455c48D93317139ADDaC8fb` |
| `SANCTIONS_LIST_START_BLOCK`     | Block at which the sanctions list oracle was deployed.                                                                | `14356508`                                   |
| `SANCTIONS_ADDRESS_REPO`         | GitHub `owner/name` repo of the UN/EU/UK/Swiss SECO/US OFAC address lists (optional).                                 | `safe-fndn/sanctions-address-lists`          |
| `GITHUB_TOKEN`                   | GitHub token for the release listing API (optional; avoids the 60/hour IP rate limit).                                | _(unset)_                                    |
| `CUMULATIVE_MERKLE_DROP_ADDRESS` | Address of the merkle drop rewards contract.                                                                          | `0xe5139Fc0FB8eae81e30d8a85C22E88c6757120f2` |
| `REALITY_MODULE_ADDRESS`         | Zodiac Reality Module on the Governance Safe (`cmd:export`, `cmd:verify`).                                            | `0x8DFc5Db2C83200Cf0cC84d7e3C441d7721ef83dC` |
| `REWARDS_ENS_NAME`               | ENS name whose `contenthash` pins the latest rewards DB (`cmd:export`, `cmd:verify`, `cmd:status`).                   | `rewards.safenet-gov.eth`                    |
| `IPFS_GATEWAY_URL`               | Trustless gateway the previous rewards DB's CAR is fetched from (`cmd:export`, `cmd:verify`, `cmd:status`, optional). | `http://127.0.0.1:8080` (local Kubo)         |
| `CONSENSUS_RPC_URL`              | RPC endpoint for the consensus chain (Gnosis Chain).                                                                  | `https://gnosis.gateway.tenderly.co`         |
| `CONSENSUS_BLOCK_PAGE_SIZE`      | Number of blocks to fetch logs for in a single RPC call on the consensus chain.                                       | `25`                                         |
| `CONSENSUS_ADDRESS`              | Address of the consensus contract.                                                                                    | `0x223624cBF099e5a8f8cD5aF22aFa424a1d1acEE9` |
| `CONSENSUS_START_BLOCK`          | Block at which consensus began. Events before this block are ignored.                                                 | `45210396`                                   |
| `SENTINEL_ORACLE_ADDRESS`        | Address of the sentinel oracle contract on the consensus chain.                                                       | _(placeholder)_                              |
| `SENTINEL_ORACLE_START_BLOCK`    | Block at which the sentinel oracle was deployed.                                                                      | _(placeholder)_                              |

Every variable can also be passed as a CLI flag using camelCase (e.g. `--databaseFile ./data.db`).

## Commands

All commands are run via `npm run <command>`. Flags use camelCase (e.g. `--rewardPeriodStart`). The reward period defaults to the most recently completed two-week window (Tuesday to Tuesday, UTC) when `--rewardPeriodStart` and `--rewardPeriodEnd` are omitted, except for `cmd:export`, `cmd:verify` and `cmd:status`, which take no period flags and derive the period from the previous rewards DB.

### `cmd:index`

Pre-fetches and indexes all on-chain events into the SQLite database. Only useful when `DATABASE_FILE` is set to a file path — with the default `:memory:` value the database is discarded when the process exits, so there is nothing to cache between runs.

```sh
DATABASE_FILE=./data.db npm run cmd:index
```

Indexing is incremental: subsequent runs only fetch events since the last indexed block. Once the database is populated, point `DATABASE_FILE` to the same file when running any of the accounting commands to avoid re-fetching from the RPC.

### `cmd:participation`

Prints validator and sentinel participation rates over a reward period in a single table, with a `Category` column distinguishing the two. Validator participation is the number of consensus signatures over the total transactions; sentinel participation is the number of sentinel oracle requests a sentinel revealed for over all requests created in the period.

```sh
npm run cmd:participation

# Specify an explicit period (Unix timestamps)
npm run cmd:participation -- --rewardPeriodStart=1700000000 --rewardPeriodEnd=1701209600

# Only print one of the two categories
npm run cmd:participation -- --category=sentinel

# Write participation rates into the validator-info.json and sentinel-info.json files inside a record directory
npm run cmd:participation -- --record=./path/to/record
```

The optional `--category` flag takes `validator`, `sentinel` or `all` (the default) and acts as a pure row filter, so the table shape and TSV header stay the same regardless of its value. Rows are grouped by category and sorted by address within each group.

Work that completes a period can land after its end, so it is counted up to the period's settlement block: 48 consensus blocks (about 4 minutes on Gnosis Chain) after the last consensus block at or before the end of the period. Events after the settlement block are never counted, however far the database is indexed, so the result for a period does not depend on when it is computed. Participation and rewards for a period are therefore only available once its settlement block exists, and the commands fail until then. Both chains are indexed up to the settlement block's timestamp, so they also fail until the staking chain has caught up to it, which takes at most one more Ethereum block.

A validator signature counts towards the period its signing ceremony completed in, and only if the ceremony's transaction attestation lands no later than the settlement block. Sentinel reveals are attributed to the period of the request they answer rather than the period they happened in, so a reveal landing after the period boundary still counts towards its request, as long as it lands no later than the settlement block. Unlike validators, there is no on-chain registry of sentinels, so only sentinels that revealed at least once appear in the output.

The `--record` flag expects the root of the `safenet-beta-data` repository and writes validator rates to `<record>/assets/validator-info.json` and sentinel rates to `<record>/assets/sentinel-info.json`, updating the `participation_rate_14d` field for any participant already in the file. Participants not yet present are inserted automatically with an empty `label`. Both files are always updated, regardless of `--category`.

### `cmd:status`

Prints JSON for the next distribution after the ENS-pinned rewards DB, using the same verified CAR and onchain Merkle root check as `cmd:export`. It derives the two-week period with the same Beta → Aegis gap rule and does no event indexing, reward computation or sanctions lookup.

```sh
npm run --silent cmd:status
npm run --silent cmd:status -- --previousCar=./previous.car
```

The JSON shape for automation is `{ "previousCid": "bafy…", "period": { "fromTimestamp": "1791849600", "toTimestamp": "1793059200" }, "settled": false }`. Timestamps are decimal strings in Unix seconds. Stdout contains only JSON; use npm's `--silent` flag to suppress its script banner. Diagnostics go to stderr.

`settled` means the consensus block exactly 48 blocks after the last block at or before the period end exists, matching `Safenet.settlement`. A period that has not ended or settled succeeds with `false`; RPC, configuration, missing previous DB and root verification errors fail. Export may still wait for Ethereum indexing to reach the settlement timestamp (up to one more Ethereum block). Release existence checks belong to the workflow.

Configuration uses the existing base environment plus required `REWARDS_ENS_NAME` and `CUMULATIVE_MERKLE_DROP_ADDRESS`. Optional `--previousCar` and `--ipfsGatewayUrl` (env `PREVIOUS_CAR` and `IPFS_GATEWAY_URL`) work as in `cmd:export`; no Reality Module configuration, period flags or reward overrides are needed. The fetched rewards DB is temporary and removed on success or failure; `DATABASE_FILE` is not opened.

### `cmd:export`

Builds the reward distribution package for the next period on top of the rewards DB that the ENS `contenthash` of `REWARDS_ENS_NAME` pins, and writes its release assets. Anyone can run it, and the same code, lockfile and `src/distribution/kyc.json` always produce byte-identical assets for a period.

```sh
npm run cmd:export -- --out=./release

# Use a local CAR of the ENS-pinned rewards DB instead of fetching it from IPFS_GATEWAY_URL
npm run cmd:export -- --out=./release --previousCar=./rewards-1791244800.car
```

The period is never chosen by the operator: it is always the two weeks that start where the previous rewards DB ends (its `rewardsUntil`, except that the rewards DB ending with Beta on 2026-10-06 is followed by the first Aegis period starting on 2026-10-13), and it covers both validator and sentinel rewards. Running the command before that period has ended and settled (48 consensus blocks after its end) fails with an error naming the period and the previous rewards DB. The previous rewards DB is never chosen by the operator: the command reads the `contenthash` of `REWARDS_ENS_NAME` and fetches that CID, as a CAR from `--previousCar` or from `IPFS_GATEWAY_URL`, verifying every block against it, and refuses to run unless its Merkle root equals `CumulativeMerkleDrop.merkleRoot()`. The governance configuration (the Governance Safe, the Reality.eth oracle and bond token, the question template, arbitrator, minimum bond and timings, and the ENS resolver) is read from `REALITY_MODULE_ADDRESS` and ENS at the same block.

`--previousCar` is only a local source for that CID: the command still verifies the file against the ENS-pinned CID and refuses any other CAR. To get one, export it from an IPFS node that has it pinned with `ipfs dag export <cid> > previous.car`, where `<cid>` is the CID the `contenthash` of `rewards.safenet-gov.eth` points to, or download the `rewards-<t>.car` asset of the previous distribution's release.

The amounts cannot be overridden, so that every export can be verified: the validator budget is the Aegis default measured against the previous rewards DB (as for `cmd:rewards` without `--totalRewards`), the per-sentinel grant is prorated over the period, and there is no minimum payout. The KYC threshold and approvals always come from `src/distribution/kyc.json`, and the sanctions lists from the period's `data-YYYY-MM-DD` snapshot release. Like the other period queries, the command indexes both chains up to the period's settlement; with a persistent `DATABASE_FILE` that `cmd:index` keeps up to date, only the remainder is fetched.

The package (`latest.json` and `proofs/`, the layout of the ENS-pinned rewards DB) is assembled in a temporary directory, packed into a CAR, and only the release assets are written to `--out`, which must be missing or empty:

| Asset                     | Contents                                                                        |
| ------------------------- | ------------------------------------------------------------------------------- |
| `rewards-<periodEnd>.car` | CARv1 of the package, whose root is the package CID                             |
| `cid.txt`                 | Package CID                                                                     |
| `merkle-root.txt`         | Merkle root                                                                     |
| `proposal.json`           | The Governance Safe transaction, its calls, its Zodiac hash and the question ID |
| `propose.json`            | Safe Transaction Builder bundle: `addProposal`                                  |
| `answer.json`             | Safe Transaction Builder bundle: `approve` and a **Yes** `submitAnswerERC20`    |
| `execute.json`            | Safe Transaction Builder bundle: `executeProposalWithIndex`                     |
| `SHA256SUMS`              | Checksums of all of the above, for `sha256sum -c`                               |

### `cmd:verify`

Re-derives the next distribution through the export pipeline and checks every onchain Reality Module question for its package CID. It uses the same configuration as `cmd:export`, with optional `--previousCar` and `--cid`, and takes no `--out`.

```sh
npm run cmd:verify

# Require the independently derived CID to equal the export artifact's CID
npm run cmd:verify -- --cid="$(cat ./release/cid.txt)"

# Use a local CAR as the source of the ENS-pinned previous rewards DB
npm run cmd:verify -- --previousCar=./previous.car
```

The previous rewards DB is resolved from ENS at the latest block and checked against the drop's root. The period is the two weeks after that DB, including the Beta → Aegis gap described above, and must have ended and settled. Use the same reward code, lockfile and `src/distribution/kyc.json` as the export. Verification rebuilds the package temporarily and reads no release assets; `--cid` lets automation tie an independent run to an export artifact.

The summary prints the previous and package CIDs, period and consensus settlement block, Merkle root, additional funding amount, total rewards, validator stake rewards and commission, unpaid validator budget, sentinel total and per-sentinel grant, forfeited grants, sanctions snapshot, and the count and addresses of newly approved KYC accounts. Reward totals are earned amounts before sanctions and KYC filters; additional funding comes from the Merkle DB update. Every token amount is printed exactly in SAFE, with up to 18 decimal places.

It also prints the derived transaction hash and the Ethereum block used for proposal lookup. Matching questions are listed by their observed IDs, alongside the module's current question mapping and execution flag. A re-asked question can match even when its ID differs from the original; cleared or invalidated mappings are printed unchanged. Execution status reports the module's flag, without checking oracle answers, bonds or execution readiness.

- With no proposal yet, it prints `Proposal: none yet` and `OK`, and exits 0 if `--cid` is omitted or matches.
- With only matching questions, it prints the current mapping and execution status, then `OK`, and exits 0 if `--cid` is omitted or matches.
- With any different question, including alongside matching questions, it names every conflicting question with `answer No`, prints `FAILED`, and exits nonzero.
- A CID mismatch prints a clear expected/derived CID error and `FAILED`, and exits nonzero. RPC or rebuild errors also exit nonzero.

There are no period, release, proposal, question, post-execution or reward override flags. After a proposal executes and advances ENS, this command verifies the distribution following the newly pinned DB; historic and post-execution verification are outside its scope.

### `cmd:rewards`

Computes and prints SAFE token reward payouts for each recipient over a reward period. Validator rewards are distributed proportionally to each validator's participation-weighted stake; sentinel grants are paid on top of them, in the same table and the same distribution.

Validators with less than 75% participation generate no rewards for themselves or their delegators. Validators below the 3.5M SAFE minimum self-stake threshold forfeit their commission on delegated stake, but still receive rewards on their own self-stake. Individual payouts below the `--minPayout` threshold (0 SAFE, i.e. no minimum, by default) are carried forward as unpaid. See the [full rewards specification](https://docs.safefoundation.org/safenet/staking/rewards) for details.

Sentinel eligibility is binary: every sentinel that revealed for at least 70% of the sentinel oracle requests created in the period receives the full per-sentinel grant, and every sentinel below the threshold receives nothing. Grants that are not awarded this way are reported as `Forfeited` and — unlike the validator `Unpaid` amount, which is rounding dust carried into the next period — are never spent. The `--minPayout` threshold does not apply to sentinel grants. As with `cmd:participation`, validator and sentinel participation only count work up to the period's settlement block, so the command fails until that block exists.

```sh
npm run cmd:rewards

# Specify an explicit period and total rewards
npm run cmd:rewards -- --totalRewards=1000000 --rewardPeriodStart=1700000000 --rewardPeriodEnd=1701209600

# Record payouts and update the Merkle distribution database
npm run cmd:rewards -- --record=./path/to/record

# Also write the Safe transaction bundle for the distribution
npm run cmd:rewards -- --record=./path/to/record --transactions=./path/to/transactions

# Print rewards as tab-separated values (TSV)
npm run cmd:rewards -- --tsv

# Show the breakdown of each payout into stake rewards, commission and sentinel grants
# (useful for tax reporting)
npm run cmd:rewards -- --split

# Override the per-sentinel grant for the period
npm run cmd:rewards -- --sentinelRewards=15000
```

The optional `--totalRewards` flag overrides the payout amount for the period (in whole SAFE tokens, 18 decimal precision); when omitted, the amount is prorated from the 5M SAFE allocated over 52 weeks for the Safenet Aegis validator program, starting on 2026-10-13. With `--record`, it also catches up to what Aegis has distributed so far, so rounding residue and unpaid amounts roll forward into later periods. The optional `--sentinelRewards` flag is its sentinel counterpart and overrides the grant paid to each eligible sentinel for the period; when omitted, it is prorated from the 400,000 SAFE granted per sentinel per year. There is deliberately no flag for the annual rate itself — like the 5M SAFE validator allocation, it is a program constant in `src/utils/sep.ts`. The optional `--minPayout` flag sets the minimum validator payout amount, in SAFE tokens, below which a payout is withheld and carried forward as unpaid instead of distributed; it defaults to `0`, i.e. no minimum. The optional `--kycThreshold` flag sets the minimum payout amount, in SAFE tokens, at or above which a payout to a recipient that is not KYC-approved is withheld in its `kycAmount`; it defaults to the threshold in `src/distribution/kyc.json`. With `--record`, every account listed in `src/distribution/kyc.json` is flagged as KYC-approved (the `kyc` field of its distribution entry) before the period's payouts, releasing any withheld amount in the same rebuild, and the newly approved accounts are printed. Approvals are never revoked, so the command refuses to record while an account already flagged in the Merkle database is missing from `src/distribution/kyc.json`. The `--record` flag expects the root of the `safenet-beta-data` repository and writes cumulative payout data and Merkle proofs into `<record>/assets/rewards/`, updating the index at `<record>/assets/rewards/latest.json`.

Validator payouts and sentinel grants are recorded as a single distribution: an address that is both a validator staker and a sentinel gets one distribution entry holding the sum, and sanctions filtering and KYC handling apply to sentinels exactly as they do to validators. Each entry records the sentinel share of its cumulative amount as `sentinelAmount`, which the index sums into `sentinelTokenTotal` in `latest.json`, so that sentinel spend does not eat into the prorated validator budget.

With `--transactions=<dir>`, a Safe transaction bundle is also written to `<dir>/rewards-<periodEnd>.json`, outside of the rewards directory. It requires `--record` and `CUMULATIVE_MERKLE_DROP_ADDRESS`, and the SAFE token address is read from the staking contract. The bundle contains two transactions: a `setMerkleRoot` call on the rewards contract and a `transfer` call on the SAFE token contract to fund it with the newly distributed amount. Both programs are funded from the same treasury Safe, so that single `transfer` covers the combined validator and sentinel amount.

### `cmd:kyc`

Applies the KYC approvals in `src/distribution/kyc.json` to the Merkle distribution database between two distributions: it flags every listed account as KYC-approved, releases any withheld `kycAmount` into `cumulativeAmount`, and rebuilds the Merkle root and proofs. This releases withheld amounts without waiting for the next `cmd:rewards --record`, which applies the same approvals anyway.

```sh
npm run cmd:kyc -- --record=./path/to/record
```

Accounts are only ever approved through `src/distribution/kyc.json`; the command takes none on the command line. The `--record` flag is required and must point at the root of the `safenet-beta-data` repository, whose last distribution must end at the period end (`--rewardPeriodEnd`, defaulting to the most recent rewards period). Like `cmd:rewards`, it refuses to run while an account already flagged in the Merkle database is missing from the file. The command rebuilds the Merkle tree using the current sanctions list before writing the updated root and proofs back into `<record>/assets/rewards/`, and prints the newly approved accounts, or `No new KYC approvals.`. With `--transactions=<dir>` and `CUMULATIVE_MERKLE_DROP_ADDRESS` set, it also writes a Safe transaction bundle with the `setMerkleRoot` call to `<dir>/kyc-<periodEnd>.json`, unless the Merkle root is unchanged, in which case it prints `Merkle root unchanged, no transaction needed.` instead.

### `cmd:validators`

Prints each validator's self-stake and total delegated stake (time-weighted averages) over a reward period. Like `cmd:participation`, it indexes up to the period's settlement block and fails until that block exists.

```sh
npm run cmd:validators

# Specify an explicit period
npm run cmd:validators -- --rewardPeriodStart=1700000000 --rewardPeriodEnd=1701209600
```

### `cmd:stake`

Prints the average staked amount per staker/validator pair over a reward period. Like `cmd:participation`, it indexes up to the period's settlement block and fails until that block exists.

```sh
npm run cmd:stake

# Specify an explicit period
npm run cmd:stake -- --rewardPeriodStart=1700000000 --rewardPeriodEnd=1701209600
```

### `cmd:totals`

Prints the current total staked amount on the network and the total number of transactions checked by Safenet. A transaction is checked when at least one sentinel revealed a verdict for its sentinel oracle request; requests that timed out without any reveal are not counted.

```sh
npm run cmd:totals

# Record totals to a network-info.json file inside a record directory
npm run cmd:totals -- --record=./path/to/record
```

The `--record` flag expects the root of the `safenet-beta-data` repository and writes results to `<record>/assets/network-info.json`.

### `cmd:sanctions`

Prints the list of sanctioned accounts that are excluded from reward payouts: addresses flagged by the on-chain Chainalysis oracle, unioned with the UN, EU, UK, Swiss SECO and US OFAC addresses currently published by [`sanctions-address-lists`](https://github.com/safe-fndn/sanctions-address-lists) (or the repository set in `SANCTIONS_ADDRESS_REPO`), fetched from its `latest` release. Unlike the on-chain oracle, the published lists have no block height to pin them to, so this command always reflects the latest fetch rather than their state at a particular payout period. A period can instead be pinned to the newest dated `data-YYYY-MM-DD` snapshot release of the same repository whose UTC day ended at or before the period end (`Safenet.pinnedSanctionedAccounts`), which also reports the release it used.

```sh
npm run cmd:sanctions
```

## Docker

The scripts can also be run as a Docker container. You can either:

- Build the image locally:
  ```sh
  docker build -t safenet-staking-scripts .
  ```
- Pull the image hosted on the GitHub Container Registry:
  ```sh
  docker pull ghcr.io/safe-fndn/safenet-staking-scripts:main
  ```

The container entrypoint accepts a command name followed by any flags. Pass configuration via environment variables with `-e`, and mount a host directory with `-v` when using a persistent database file.

```sh
# Run the participation command
docker run --rm --env-file .env ghcr.io/safe-fndn/safenet-staking-scripts:main participation

# Use a persistent database mounted from the host; set DATABASE_FILE to the
# in-container path, overriding the value in .env
docker run \
  --rm \
  --env-file .env \
  -e DATABASE_FILE=/safenet.db \
  -v ./safenet.db:/safenet.db \
  ghcr.io/safe-fndn/safenet-staking-scripts:main \
  index

# Pass flags after the command name
docker run --rm --env-file .env ghcr.io/safe-fndn/safenet-staking-scripts:main \
  rewards --totalRewards=1000000 --rewardPeriodStart=1700000000 --rewardPeriodEnd=1701209600
```

## Tests

```sh
npm test
```

To run tests in watch mode during development:

```sh
npm run test:watch
```

## Other Scripts

| Script          | Description                                                   |
| --------------- | ------------------------------------------------------------- |
| `npm run build` | Compiles TypeScript to `dist/` using the production tsconfig. |
| `npm run check` | Runs Biome linting and TypeScript type-checking.              |
| `npm run fix`   | Runs Biome with auto-fix enabled.                             |
