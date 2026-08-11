# InboxViews fallback vs FeeManager — bytecode size comparison

Measured with `npm run check:bytecode-size` (solc 0.8.28, deployedBytecode).

## After inlining `InboxFeeQuoter` + `MinerRejectTools` into Inbox

Only `{MpcAbiReEncode}` remains a separate DELEGATECALL helper (plus oracles / MPC executors that are not Inbox facets).

| Artifact | pre-split `8903dbb` | FeeManager tip | Views-fallback (views moved) | **+ inline quoter/reject tools** |
|---|---:|---:|---:|---:|
| Inbox | 24,457 | 23,173 | 21,813 | **22,661** |
| EIP-170 headroom | 119 | 1,403 | 2,763 | **1,915** |
| Extension | — | FeeManager 4,668 | InboxViews 15,144 | InboxViews **15,750** |
| InboxFeeQuoter | 904 | 904 | 904 | *(inlined)* |
| MinerRejectTools | 1,464 | 1,464 | 1,464 | *(inlined)* |

Delta from views-only → +inline: Inbox **+848** bytes (22,661 − 21,813); still **~1.9KB** under the 24,576 limit and still leaner than FeeManager tip’s Inbox (23,173).

## Takeaway

- Views/`estimate` fallback split is what bought most of the headroom.
- Putting fee-quote + reject-tool helpers back on Inbox costs ~0.85KB and remains EIP-170-safe on this branch.
- `InboxViews` is still fat (~15.7KB) because it inherits `InboxBase`/`InboxFeeManager` for storage layout (should be slimmed to a store-only layout later).
- Keep **`MpcAbiReEncode`** as the only Inbox DELEGATECALL helper for encode.

This branch is for comparison only; it is not a replacement for PR #10.
