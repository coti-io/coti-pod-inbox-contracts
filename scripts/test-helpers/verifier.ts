import { concat, toHex, type Hex } from "viem";
import { sign } from "viem/accounts";

/** Hardhat/Anvil account 0. Tests set verifier to this address. */
export const HARDHAT_VERIFIER_PK =
  "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;

type AuthInbox = {
  write: {
    setVerifier: (args: [`0x${string}`], opts?: { account: `0x${string}` }) => Promise<unknown>;
  };
};

type HashBatchInbox = {
  read: {
    hashBatch: (args: [bigint, readonly unknown[]]) => Promise<Hex>;
  };
};

/** Owner-set CMS verifier (tests: deployer = account 0). */
export const enableInboxAuth = async (inbox: AuthInbox, account: `0x${string}`): Promise<void> => {
  await inbox.write.setVerifier([account], { account });
};

export const signVerifierBatch = async (
  inbox: HashBatchInbox,
  sourceChainId: bigint,
  mined: readonly unknown[],
  privateKey: `0x${string}` = HARDHAT_VERIFIER_PK
): Promise<Hex> => {
  const digest = await inbox.read.hashBatch([sourceChainId, mined]);
  const raw = await sign({ hash: digest, privateKey });
  const v = raw.yParity === 0 ? 27 : 28;
  return concat([raw.r, raw.s, toHex(v, { size: 1 })]);
};

/** Args tuple for `batchProcessRequests`. */
export const mineArgs = async (
  inbox: HashBatchInbox,
  sourceChainId: bigint,
  mined: readonly unknown[],
  privateKey?: `0x${string}`
): Promise<[bigint, readonly unknown[], Hex]> => {
  const sig = await signVerifierBatch(inbox, sourceChainId, mined, privateKey);
  return [sourceChainId, mined, sig];
};
