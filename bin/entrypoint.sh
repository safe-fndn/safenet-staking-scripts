#!/bin/sh

set -eu

if [ $# -lt 1 ]; then
	echo "ERROR: Missing command to execute." >&2
	exit 1
fi

cmd="$1"
shift

exec node "/app/dist/cmd/$cmd.js" "$@"
