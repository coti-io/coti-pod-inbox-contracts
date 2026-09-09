import { toHex } from "viem";

/** Must match InboxBase.REQUEST_ID_VERSION. */
export const REQUEST_ID_VERSION = 1n;

/** Pack source/target chain ids + Inbox generation + nonce the same way as InboxBase._packRequestId. */
export const packRequestId = (source: bigint, target: bigint, nonce: bigint): `0x${string}` => {
  const packed = (source << 192n) | (target << 128n) | (REQUEST_ID_VERSION << 120n) | nonce;
  return toHex(packed, { size: 32 });
};
