#!/bin/sh
set -e

COMMAND=$1
shift

exec node_modules/.bin/tsx "src/cmd/${COMMAND}.ts" "$@"
