#!/usr/bin/env bash
# Symlink MpcCore from coti-contracts (single source of truth for MPC types).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Prefer pod-mpc-lib vendored MpcCore (^0.8.20) until coti-contracts MpcInterface pragma aligns.
if [[ -d "${ROOT}/../pod-mpc-lib/contracts/utils/mpc" ]]; then
  MPC_SRC="${ROOT}/../pod-mpc-lib/contracts/utils/mpc"
else
  MPC_SRC="${ROOT}/../coti-contracts/contracts/utils/mpc"
fi
MPC_DEST="${ROOT}/contracts/utils/mpc"
if [[ ! -d "$MPC_SRC" ]]; then
  echo "error: coti-contracts mpc utils not found at $MPC_SRC" >&2
  exit 1
fi
mkdir -p "$(dirname "$MPC_DEST")"
rm -rf "$MPC_DEST"
ln -sf "$(realpath "$MPC_SRC")" "$MPC_DEST"
echo "Linked $MPC_DEST -> $(realpath "$MPC_SRC")"
