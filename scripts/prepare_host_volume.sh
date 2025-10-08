#!/bin/sh
# Prepare host volume path for chesspuzzle-data so sqlite can write to it when
# a host bind mount is used instead of a named volume.
# Usage: prepare_host_volume.sh /absolute/path/to/chesspuzzle-data <uid> <gid>
set -e
TARGET=${1:-/var/lib/chesspuzzle/data}
UID=${2:-1000}
GID=${3:-1000}

echo "Preparing host volume directory: $TARGET (uid=$UID gid=$GID)"
mkdir -p "$TARGET"
chown -R ${UID}:${GID} "$TARGET"
chmod -R 770 "$TARGET"

echo "Done"
