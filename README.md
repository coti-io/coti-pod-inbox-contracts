# COTI PoD Inbox Contracts

Cross-chain **inbox** implementation for the COTI PoD stack: message routing, miner, fee manager, and `MpcAbiCodec`.

dApp contracts (Privacy Portal, pERC20, PodLib, examples) live in **[coti-contracts](https://github.com/coti-io/coti-contracts)** under `contracts/pod/`.

Integration tests, deploy orchestration, and the multi-repo dev workspace live in **[pod-ecosystem-integration](https://github.com/coti-io/pod-ecosystem-integration)**.

## Layout

| Path | Purpose |
|------|---------|
| `contracts/Inbox.sol` | Production inbox (miner + access control) |
| `contracts/InboxBase.sol` | Core send/receive/request storage |
| `contracts/InboxMiner.sol` | Batch miner for incoming requests |
| `contracts/fee/` | Fee manager and price oracle |
| `contracts/mpccodec/MpcAbiCodec.sol` | MPC method-call encoder (also synced to dApps) |
| `contracts/IInbox.sol`, `InboxUser.sol` | Stable APIs copied into coti-contracts |

## Sync to coti-contracts

After changing inbox-facing interfaces, push copies to dApp consumers:

```bash
npm run sync:interfaces -- ../coti-contracts
# or
TARGET=../coti-contracts ./scripts/sync-inbox-interfaces.sh
```

Synced files land in `coti-contracts/contracts/pod/inbox/` with `SYNC_MANIFEST.json` (commit + hashes).

## Develop

```bash
npm install
npx hardhat compile
npm run test:inbox-events
npm run test:inbox-fee
```

For full-stack work (inbox + dApps + E2E tests), open the **pod-ecosystem-integration** workspace.

## Networks

See `hardhat.config.ts` — Sepolia, Avalanche Fuji, COTI testnet, and local `chain1`/`chain2` simulators for multichain tests.
