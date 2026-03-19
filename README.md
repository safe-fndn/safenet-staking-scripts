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

**Prerequisites:** Node.js 20+, npm.

```sh
npm ci
```

Copy the sample environment file and fill in your values:

```sh
cp .env.sample .env
```

All scripts read configuration from environment variables (or from a `.env` file in the project root). The available variables are:

| Variable | Description | Default in `.env.sample` |
|---|---|---|
| `DEBUG` | Debug log filter. All logs are under the `safenet:` prefix. | `safenet,safenet:*` |
| `DATABASE_FILE` | Path to the SQLite database file for cached events. Use `:memory:` to disable persistence. | `:memory:` |
| `BLOCK_PAGE_SIZE` | Number of blocks to fetch logs for in a single RPC call. | `50` |
| `STAKING_RPC_URL` | RPC endpoint for the staking chain (Sepolia). | `https://sepolia.gateway.tenderly.co` |
| `STAKING_ADDRESS` | Address of the staking contract. | |
| `STAKING_START_BLOCK` | Block at which the staking contract was deployed. | |
| `CONSENSUS_RPC_URL` | RPC endpoint for the consensus chain (Gnosis Chain). | `https://rpc.gnosischain.com` |
| `CONSENSUS_ADDRESS` | Address of the consensus contract. | |
| `CONSENSUS_START_BLOCK` | Block at which consensus began. Events before this block are ignored. | |

Every variable can also be passed as a CLI flag using camelCase (e.g. `--databaseFile ./data.db`).

## Commands

All commands are run via `npm run <command>`. Flags use camelCase (e.g. `--rewardPeriodStart`). The reward period defaults to the most recently completed two-week window (Sunday to Sunday, UTC) when `--rewardPeriodStart` and `--rewardPeriodEnd` are omitted.

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

# Use approximate mode (faster, based on raw signature events rather than per-transaction lookup)
npm run cmd:participation -- --approximate

# Write participation rates into a validator-info.json file inside a record directory
npm run cmd:participation -- --record=./path/to/record
```

The `--record` flag writes results to `<record>/assets/validator-info.json`, updating the `participation_rate_14d` field for any validator already in the file. Validators not yet present are inserted automatically — the file does not need to pre-list them.

### `cmd:rewards`

Computes and prints SAFE token reward payouts for each recipient over a reward period. Rewards are distributed proportionally to each validator's participation-weighted stake.

Validators with less than 75% participation generate no rewards for themselves or their delegators. Validators below the 3.5M SAFE minimum self-stake threshold forfeit their commission on delegated stake, but still receive rewards on their own self-stake. Individual payouts below 1 SAFE are carried forward as unpaid.

```sh
npm run cmd:rewards -- --totalRewards=1000000

# Specify an explicit period
npm run cmd:rewards -- --totalRewards=1000000 --rewardPeriodStart=1700000000 --rewardPeriodEnd=1701209600

# Record payouts and update the Merkle distribution database
npm run cmd:rewards -- --totalRewards=1000000 --record=./path/to/record
```

The `--totalRewards` flag is required and takes the amount in whole SAFE tokens (18 decimal precision). The `--record` flag writes cumulative payout data and Merkle proofs into `<record>/assets/rewards/` and updates the index at `<record>/assets/rewards/latest.json`.

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

The `--record` flag writes results to `<record>/assets/network-info.json`.

## Tests

```sh
npm test
```

To run tests in watch mode during development:

```sh
npm run test:watch
```

## Other Scripts

| Script | Description |
|---|---|
| `npm run build` | Compiles TypeScript to `dist/` using the production tsconfig. |
| `npm run check` | Runs Biome linting and TypeScript type-checking. |
| `npm run fix` | Runs Biome with auto-fix enabled. |
