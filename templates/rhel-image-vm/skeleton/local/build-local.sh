#!/usr/bin/env bash
# Build the bootc image and a raw disk for Apple Silicon (arm64) inside the
# existing podman machine. Rootful podman runs inside the machine via
# `podman machine ssh sudo`; the machine itself stays rootless.
#
#   REGISTRY_AUTH_FILE=/path/to/auth.json ENTITLEMENT_DIR=/path/to/ent local/build-local.sh
#
# REGISTRY_AUTH_FILE must contain a registry.redhat.io credential.
# ENTITLEMENT_DIR must contain entitlement.pem and entitlement-key.pem (the
# cluster's openshift-config-managed/etc-pki-entitlement), used only as build
# secrets for dnf. Both must live under /Users or /private so the machine can
# read them. Neither is ever copied into the repository or the image.
set -euo pipefail

REPO=$(cd "$(dirname "$0")/.." && pwd)
AUTH=${REGISTRY_AUTH_FILE:?set REGISTRY_AUTH_FILE to a registry.redhat.io auth.json}
ENT=${ENTITLEMENT_DIR:?set ENTITLEMENT_DIR to a directory with entitlement.pem and entitlement-key.pem}
SSH_PUB=${SSH_PUB:-$HOME/.ssh/id_ed25519.pub}
OUT=${OUT:-$REPO/local/output}
IMAGE=localhost/${{ values.name }}:local
BIB=registry.redhat.io/rhel10/bootc-image-builder:10.2@sha256:14adeb06f5fca459c8ac534b59f1dec6d08576dfdf4605b0b27f177ad19f1de8
REV=$(git -C "$REPO" rev-parse --verify -q HEAD || echo local)
WORK=/var/tmp/${{ values.name }}   # inside the machine, off virtiofs

mkdir -p "$OUT"
# The local-only disk config adds an admin user with your SSH public key.
# On a local VM there is no qemu-guest-agent channel, so the key is baked into the
# local disk only. Cluster VMs receive keys at runtime from KubeVirt accessCredentials.
printf '[[customizations.user]]\nname = "cloud-user"\nkey = "%s"\ngroups = ["wheel"]\n' "$(cat "$SSH_PUB")" > "$OUT/config.local.toml"

vm() { podman machine ssh -- "$@"; }

vm sudo podman build --platform linux/arm64 --authfile "$AUTH" \
  --secret id=entitlement-cert,src="$ENT/entitlement.pem" \
  --secret id=entitlement-key,src="$ENT/entitlement-key.pem" \
  --build-arg SOURCE_REVISION="$REV" -t "$IMAGE" "$REPO"
vm sudo podman pull -q --authfile "$AUTH" "$BIB"
vm sudo rm -rf "$WORK"
vm sudo mkdir -p "$WORK/output"
vm sudo podman run --rm --privileged --pull=never \
  --security-opt label=type:unconfined_t \
  -v /var/lib/containers/storage:/var/lib/containers/storage \
  -v "$OUT/config.local.toml:/config.toml:ro" \
  -v "$WORK/output:/output" \
  "$BIB" --type raw --rootfs xfs "$IMAGE"
vm sudo cp --sparse=always "$WORK/output/image/disk.raw" "$OUT/disk.raw"
vm sudo rm -rf "$WORK"
echo "disk: $OUT/disk.raw"
