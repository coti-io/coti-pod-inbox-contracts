# InboxViews fallback vs FeeManager — bytecode size comparison

Measured with `npm run check:bytecode-size` (solc 0.8.28, deployedBytecode).

Only `{MpcAbiReEncode}` remains a separate DELEGATECALL helper (plus oracles / MPC executors).

| Artifact | pre-split `8903dbb` | FeeManager tip | Views moved | + inline quoter/reject | **+ explorer stubs** |
|---|---:|---:|---:|---:|---:|
| Inbox | 24,457 | 23,173 | 21,813 | 22,661 | **22,964** |
| EIP-170 headroom | 119 | 1,403 | 2,763 | 1,915 | **612** |
| Extension | — | FeeManager 4,668 | InboxViews 15,144 | 15,750 | 15,750 |

## Stubs note

Explorer stubs (`InboxViewsStubBase`) are **not** Solidity `view`: `delegatecall` is forbidden in `view` (including assembly). `staticcall` to the facet address would read the **facet's** storage, not Inbox's. Stubs DELEGATECALL + forward returndata; outer `eth_call` still works. Facet functions remain `view` for correct semantics under an outer static context.

## Takeaway

- Views/estimate split buys the headroom; stubs cost ~300B more after returndata-forward implementation.
- Still EIP-170-safe (~0.6KB headroom) on this comparison branch.
- `InboxViews` is still fat (~15.7KB) due to inheriting `InboxBase`/`FeeManager` for layout.

This branch is for comparison only; it is not a replacement for PR #10.
