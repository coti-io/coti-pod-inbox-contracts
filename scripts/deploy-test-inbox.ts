/**
 * Deploy Inbox + {MpcAbiReEncode} + {InboxViews} for Hardhat / EDR unit tests (no CreateX).
 * Returns an Inbox-address contract with a merged Inbox+InboxViews ABI so view/estimate
 * selectors hit Inbox {fallback} → DELEGATECALL {InboxViews}.
 */

import { getContract } from "viem";

type DeployOpts = Record<string, unknown> & {
  client?: {
    public?: unknown;
    wallet?: { account?: { address: `0x${string}` } };
  };
};

type ViemLike = {
  deployContract: (name: string, args: unknown[], opts?: DeployOpts) => Promise<any>;
};

const codecByKey = new WeakMap<object, Promise<{ address: `0x${string}`; abi: readonly any[] }>>();
const viewsByKey = new WeakMap<object, Promise<{ address: `0x${string}`; abi: readonly any[] }>>();

const mergeAbis = (baseAbi: readonly any[], extraAbi: readonly any[]): any[] => {
  // Prefer facet (InboxViews) function entries when present so clients keep `read.*` / view
  // eth_call UX even though on-chain Inbox stubs are non-view (delegatecall requirement).
  const byKey = new Map<string, any>();
  const order: string[] = [];
  const keyOf = (item: any) => {
    if (item?.type === "function") {
      return `fn:${item.name}:${(item.inputs ?? []).map((i: any) => i.type).join(",")}`;
    }
    return `other:${JSON.stringify(item)}`;
  };
  for (const item of baseAbi) {
    const k = keyOf(item);
    if (!byKey.has(k)) order.push(k);
    byKey.set(k, item);
  }
  for (const item of extraAbi) {
    const k = keyOf(item);
    if (!byKey.has(k)) order.push(k);
    byKey.set(k, item); // facet overwrites stub mutability
  }
  return order.map((k) => byKey.get(k));
};

/** Deploy (or reuse) helpers, then deploy Inbox bound with merged ABI. */
export const deployTestInbox = async (
  viem: ViemLike,
  opts?: DeployOpts
): Promise<any & { mpcAbiReEncode: `0x${string}`; inboxViews: `0x${string}` }> => {
  const walletKey = (opts?.client?.wallet ?? viem) as object;

  let codecPromise = codecByKey.get(walletKey);
  if (!codecPromise) {
    codecPromise = (async () => {
      const codec = await viem.deployContract("MpcAbiReEncode", [], opts);
      return { address: codec.address as `0x${string}`, abi: codec.abi as readonly any[] };
    })();
    codecByKey.set(walletKey, codecPromise);
  }

  let viewsPromise = viewsByKey.get(walletKey);
  if (!viewsPromise) {
    viewsPromise = (async () => {
      const views = await viem.deployContract("InboxViews", [], opts);
      return { address: views.address as `0x${string}`, abi: views.abi as readonly any[] };
    })();
    viewsByKey.set(walletKey, viewsPromise);
  }

  const codec = await codecPromise;
  const views = await viewsPromise;
  const inbox = await viem.deployContract("Inbox", [], opts);
  const mergedAbi = mergeAbis(inbox.abi as readonly any[], views.abi);

  const publicClient = opts?.client?.public as any;
  const walletClient = opts?.client?.wallet as any;
  const bound =
    publicClient != null
      ? (getContract({
          address: inbox.address as `0x${string}`,
          abi: mergedAbi,
          client: { public: publicClient, wallet: walletClient },
        }) as any)
      : Object.assign(inbox, { abi: mergedAbi });

  Object.defineProperty(bound, "mpcAbiReEncode", {
    value: codec.address,
    enumerable: true,
  });
  Object.defineProperty(bound, "inboxViews", {
    value: views.address,
    enumerable: true,
  });
  return bound as any;
};

/** Address of the shared test {MpcAbiReEncode} for a prior {deployTestInbox} call. */
export const mpcAbiReEncodeOf = (inbox: { mpcAbiReEncode?: `0x${string}` }): `0x${string}` => {
  const addr = inbox.mpcAbiReEncode;
  if (!addr) throw new Error("mpcAbiReEncodeOf: missing address (deploy via deployTestInbox)");
  return addr;
};

/** Address of the shared test {InboxViews} for a prior {deployTestInbox} call. */
export const inboxViewsOf = (inbox: { inboxViews?: `0x${string}` }): `0x${string}` => {
  const addr = inbox.inboxViews;
  if (!addr) throw new Error("inboxViewsOf: missing address (deploy via deployTestInbox)");
  return addr;
};

/** Standard init args: owner, chainId, mpcAbiReEncode, inboxViews. */
export const inboxInitArgs = (
  inbox: { mpcAbiReEncode?: `0x${string}`; inboxViews?: `0x${string}` },
  owner: `0x${string}`,
  chainId: bigint
): [`0x${string}`, bigint, `0x${string}`, `0x${string}`] => [
  owner,
  chainId,
  mpcAbiReEncodeOf(inbox),
  inboxViewsOf(inbox),
];
