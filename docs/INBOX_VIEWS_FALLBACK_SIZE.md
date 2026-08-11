# InboxViews fallback vs FeeManager — bytecode size comparison

Measured with `npm run check:bytecode-size` (solc 0.8.28, deployedBytecode).

| Artifact | pre-split `8903dbb` | FeeManager (`naiem/c01-lane-wedge-caps`) | Views-fallback (this branch) |
|---|---:|---:|---:|
| Inbox | 24,457 | 23,173 | **21,813** |
| EIP-170 headroom | 119 | 1,403 | **2,763** |
| Extension | — | FeeManager 4,668 | InboxViews 15,144 |

## Takeaway

Moving **views + estimate orchestration** out via `fallback()` DELEGATECALL recovers **more Inbox create headroom** (~2.6KB) than the FeeManager domain split (~1.3KB) on this base, because the view/estimate bodies are larger than the remaining fee validate path after prior packing.

Trade-offs:

- Clients must attach an InboxViews ABI fragment (Diamond-style); `view` getters cannot be thin Solidity stubs that DELEGATECALL.
- `InboxViews` itself is large (~15KB) because it inherits the storage-aligned InboxBase/MinerBase tree for DELEGATECALL identity.
- FeeManager keeps fee logic upgradeable/swappable as a smaller module and leaves explorer stubs on Inbox.

This branch is for comparison only; it is not a replacement for PR #10.
