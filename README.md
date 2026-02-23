# Safenet Accounting

This repository contains code to help accounting for Safenet. In particular, it indexes Safenet consensus events to compute things like participation rates for validators in order to calculate SAFE rewards at the end of each accounting period.

## Design Overview

Instead of loading all consensus events in memory and doing accounting from there, the scripts are design to first index events into a local SQLite database, and then perform accounting computation from the indexed events. This has a few benefits:

- We do not need to worry about the memory footprint of loading potentially 100s of 1000s of events in memory.
- Seamlessly recover from intermittent network events while querying a node for events.
- Reduce RPC node credit usage during development.
- Can potentially tweak accounting parameters between runs without having to wait for all events.

## Development setup

```sh
npm ci
```
