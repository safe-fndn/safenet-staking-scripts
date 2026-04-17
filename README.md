# Safenet Accounting

Scripts for indexing Safenet Beta consensus events and computing validator participation rates and SAFE reward payouts at the end of each accounting period.

> [!NOTE]
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

| Variable                         | Description                                                                                | Default in `.env.sample`                     |
| -------------------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------- |
| `DEBUG`                          | Debug log filter. All logs are under the `safenet:` prefix.                                | `safenet,safenet:*`                          |
| `DATABASE_FILE`                  | Path to the SQLite database file for cached events. Use `:memory:` to disable persistence. | `:memory:`                                   |
| `STAKING_RPC_URL`                | RPC endpoint for the staking chain (Ethereum mainnet).                                     | `https://mainnet.gateway.tenderly.co`        |
| `STAKING_BLOCK_PAGE_SIZE`        | Number of blocks to fetch logs for in a single RPC call on the staking chain.              | `100`                                        |
| `STAKING_ADDRESS`                | Address of the staking contract.                                                           | `0x115E78f160e1E3eF163B05C84562Fa16fA338509` |
| `STAKING_START_BLOCK`            | Block at which the staking contract was deployed.                                          | `24585750`                                   |
| `SANCTIONS_LIST_ADDRESS`         | Address of the Chainalysis sanctions list oracle.                                          | `0x40C57923924B5c5c5455c48D93317139ADDaC8fb` |
| `SANCTIONS_LIST_START_BLOCK`     | Block at which the sanctions list oracle was deployed.                                     | `14356508`                                   |
| `CUMULATIVE_MERKLE_DROP_ADDRESS` | Address of the merkle drop rewards contract.                                               | `0xe5139Fc0FB8eae81e30d8a85C22E88c6757120f2` |
| `CONSENSUS_RPC_URL`              | RPC endpoint for the consensus chain (Gnosis Chain).                                       | `https://gnosis.gateway.tenderly.co`         |
| `CONSENSUS_BLOCK_PAGE_SIZE`      | Number of blocks to fetch logs for in a single RPC call on the consensus chain.            | `25`                                         |
| `CONSENSUS_ADDRESS`              | Address of the consensus contract.                                                         | `0x223624cBF099e5a8f8cD5aF22aFa424a1d1acEE9` |
| `CONSENSUS_START_BLOCK`          | Block at which consensus began. Events before this block are ignored.                      | `45210396`                                   |

Every variable can also be passed as a CLI flag using camelCase (e.g. `--databaseFile ./data.db`).

## Commands

All commands are run via `npm run <command>`. Flags use camelCase (e.g. `--rewardPeriodStart`). The reward period defaults to the most recently completed two-week window (Tuesday to Tuesday, UTC) when `--rewardPeriodStart` and `--rewardPeriodEnd` are omitted.

### `cmd:index`

Pre-fetches and indexes all on-chain events into the SQLite database. Only useful when `DATABASE_FILE` is set to a file path — with the default `:memory:` value the database is discarded when the process exits, so there is nothing to cache between runs.

```sh
DATABASE_FILE=./data.db npm run cmd:index
```

Indexing is incremental: subsequent runs only fetch events since the last indexed block. Once the database is populated, point `DATABASE_FILE` to the same file when running any of the accounting commands to avoid re-fetching from the RPC.

### `cmd:participation`

Prints each validator's participation rate (number of consensus signatures / total transactions) over a reward period.

```sh
npm run cmd:participation

# Specify an explicit period (Unix timestamps)
npm run cmd:participation -- --rewardPeriodStart=1700000000 --rewardPeriodEnd=1701209600

# Write participation rates into a validator-info.json file inside a record directory
npm run cmd:participation -- --record=./path/to/record
```

The `--record` flag expects the root of the `safenet-beta-data` repository and writes results to `<record>/assets/validator-info.json`, updating the `participation_rate_14d` field for any validator already in the file. Validators not yet present are inserted automatically.

### `cmd:rewards`

Computes and prints SAFE token reward payouts for each recipient over a reward period. Rewards are distributed proportionally to each validator's participation-weighted stake.

Validators with less than 75% participation generate no rewards for themselves or their delegators. Validators below the 3.5M SAFE minimum self-stake threshold forfeit their commission on delegated stake, but still receive rewards on their own self-stake. Individual payouts below 1 SAFE are carried forward as unpaid. See the [full rewards specification](https://docs.safefoundation.org/safenet/staking/rewards) for details.

```sh
npm run cmd:rewards -- --totalRewards=1000000

# Specify an explicit period
npm run cmd:rewards -- --totalRewards=1000000 --rewardPeriodStart=1700000000 --rewardPeriodEnd=1701209600

# Record payouts and update the Merkle distribution database
npm run cmd:rewards -- --totalRewards=1000000 --record=./path/to/record
```

The `--totalRewards` flag is required and takes the amount in whole SAFE tokens (18 decimal precision). The `--record` flag expects the root of the `safenet-beta-data` repository and writes cumulative payout data and Merkle proofs into `<record>/assets/rewards/`, updating the index at `<record>/assets/rewards/latest.json`.

When `CUMULATIVE_MERKLE_DROP_ADDRESS` and `SAFE_TOKEN_ADDRESS` are also set, a Safe transaction bundle is written to `<record>/assets/rewards/transactions/rewards-<periodEnd>.json`. The bundle contains two transactions: a `setMerkleRoot` call on the rewards contract and a `transfer` call on the SAFE token contract to fund it with the newly distributed amount.

### `cmd:validators`

Prints each validator's self-stake and total delegated stake (time-weighted averages) over a reward period.

```sh
npm run cmd:validators

# Specify an explicit period
npm run cmd:validators -- --rewardPeriodStart=1700000000 --rewardPeriodEnd=1701209600
```

### `cmd:stake`

Prints the average staked amount per staker/validator pair over a reward period.

```sh
npm run cmd:stake

# Specify an explicit period
npm run cmd:stake -- --rewardPeriodStart=1700000000 --rewardPeriodEnd=1701209600
```

### `cmd:totals`

Prints the current total staked amount on the network and the total number of transactions checked by Safenet.

```sh
npm run cmd:totals

# Record totals to a network-info.json file inside a record directory
npm run cmd:totals -- --record=./path/to/record
```

The `--record` flag expects the root of the `safenet-beta-data` repository and writes results to `<record>/assets/network-info.json`.

### `cmd:sanctions`

Prints the list of sanctioned accounts that are excluded from reward payouts.

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
