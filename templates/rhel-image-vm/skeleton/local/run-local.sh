#!/usr/bin/env bash
# Boot local/output/disk.raw with vfkit (Apple Virtualization.framework), using
# the vfkit binary bundled with Homebrew podman.
#   local/run-local.sh            # serial console on this terminal
#   CONSOLE=log local/run-local.sh  # serial console to local/output/console.log (background use)
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
OUT=$REPO/local/output
VFKIT=${VFKIT:-$(ls -d "$(brew --prefix podman)"/libexec/podman/vfkit 2>/dev/null || command -v vfkit)}
MAC=${MAC:-5a:94:ef:b0:c1:01}

serial="virtio-serial,stdio"
[ "${CONSOLE:-stdio}" = log ] && serial="virtio-serial,logFilePath=$OUT/console.log"

echo "Guest MAC $MAC. Find the IP with: grep -B1 -A3 '${MAC#0}' /var/db/dhcpd_leases"
exec "$VFKIT" --cpus 2 --memory 2048 \
  --bootloader "efi,variable-store=$OUT/efi-vars,create" \
  --device "virtio-blk,path=$OUT/disk.raw" \
  --device "virtio-net,nat,mac=$MAC" \
  --device "$serial" \
  --device virtio-rng
