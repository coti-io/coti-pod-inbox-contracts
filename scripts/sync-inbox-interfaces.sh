#!/usr/bin/env bash
# Sync stable inbox-facing APIs from this repo into coti-contracts/contracts/pod/inbox/.
#
# Usage:
#   ./scripts/sync-inbox-interfaces.sh /path/to/coti-contracts
#   TARGET=/path/to/coti-contracts ./scripts/sync-inbox-interfaces.sh
#
# Do not edit synced files in coti-contracts by hand — change here and re-run sync.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
TARGET_ROOT="${1:-${TARGET:-}}"

if [[ -z "$TARGET_ROOT" ]]; then
  echo "Usage: $0 <path-to-coti-contracts>" >&2
  exit 1
fi

DEST="${TARGET_ROOT}/contracts/pod/inbox"
mkdir -p "$DEST"

SYNC_FILES=(
  contracts/IInbox.sol
  contracts/IInboxMiner.sol
  contracts/InboxUser.sol
  contracts/InboxUserCotiTestnet.sol
  contracts/fee/IInboxFeeManager.sol
  contracts/mpccodec/MpcAbiCodec.sol
)

for rel in "${SYNC_FILES[@]}"; do
  src="${REPO_ROOT}/${rel}"
  base="$(basename "$rel")"
  cp "$src" "${DEST}/${base}"
done

# MpcAbiCodec: fix imports for coti-contracts layout (pod/inbox/ → contracts/utils/mpc/)
sed -i 's|import "../IInbox.sol"|import "./IInbox.sol"|g' "${DEST}/MpcAbiCodec.sol"
sed -i 's|import "../utils/mpc/MpcCore.sol"|import "../../utils/mpc/MpcCore.sol"|g' "${DEST}/MpcAbiCodec.sol"
sed -i 's|import "../../utils/mpc/MpcCore.sol"|import "../../utils/mpc/MpcCore.sol"|g' "${DEST}/MpcAbiCodec.sol"

MANIFEST="${DEST}/SYNC_MANIFEST.json"
python3 - "$REPO_ROOT" "$MANIFEST" "${SYNC_FILES[@]}" <<'PY'
import hashlib, json, os, subprocess, sys
from datetime import datetime, timezone

repo_root, manifest_path = sys.argv[1], sys.argv[2]
files = sys.argv[3:]

def git_sha(root):
    try:
        return subprocess.check_output(["git", "-C", root, "rev-parse", "HEAD"], text=True).strip()
    except Exception:
        return "unknown"

entries = []
for rel in files:
    path = os.path.join(repo_root, rel)
    with open(path, "rb") as f:
        h = hashlib.sha256(f.read()).hexdigest()
    entries.append({"source": rel, "dest": os.path.basename(rel), "sha256": h})

doc = {
    "syncedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "sourceRepo": "coti-pod-inbox-contracts",
    "sourceCommit": git_sha(repo_root),
    "files": entries,
}
with open(manifest_path, "w") as f:
    json.dump(doc, f, indent=2)
    f.write("\n")
print(f"Wrote {manifest_path} ({len(entries)} files)")
PY

echo "Synced inbox interfaces to ${DEST}"
