/**
 * Shared ABI encode/decode and split/combine helpers for 128-bit and 256-bit MPC types.
 * Used by mpc-abi-codec-128.ts, mpc-abi-codec-256.ts, and system test utils.
 */
import { decodeAbiParameters, encodeAbiParameters } from "viem";

// --- 128-bit helpers ---

export function split128To64Parts(value: bigint): [bigint, bigint] {
  const mask64 = (1n << 64n) - 1n;
  const low = value & mask64;
  const high = (value >> 64n) & mask64;
  return [high, low];
}

export function combine64PartsTo128(high: bigint, low: bigint): bigint {
  return (high << 64n) | low;
}

/** ctUint128 is a single uint256 user-defined value type. */
export function decodeCtUint128FromBytes(data: `0x${string}`): bigint {
  const [decoded] = decodeAbiParameters([{ type: "uint256" }], data);
  return decoded as bigint;
}

export function encodeCtUint128(value: bigint): `0x${string}` {
  return encodeAbiParameters([{ type: "uint256" }], [value]);
}

/** itUint128 = { ctUint128 ciphertext, bytes signature } */
export function encodeItUint128(
  ciphertext: bigint,
  signature: `0x${string}`
): `0x${string}` {
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { type: "uint256", name: "ciphertext" },
          { type: "bytes", name: "signature" },
        ],
      },
    ],
    [{ ciphertext, signature }]
  );
}

// --- 256-bit helpers ---

export function split256To64Parts(value: bigint): [bigint, bigint, bigint, bigint] {
  const mask64 = (1n << 64n) - 1n;
  const lowLow = value & mask64;
  const lowHigh = (value >> 64n) & mask64;
  const highLow = (value >> 128n) & mask64;
  const highHigh = (value >> 192n) & mask64;
  return [highHigh, highLow, lowHigh, lowLow];
}

export function combine64PartsTo256(
  highHigh: bigint,
  highLow: bigint,
  lowHigh: bigint,
  lowLow: bigint
): bigint {
  return (highHigh << 192n) | (highLow << 128n) | (lowHigh << 64n) | lowLow;
}

export function split256To128Parts(value: bigint): [bigint, bigint] {
  const mask128 = (1n << 128n) - 1n;
  return [(value >> 128n) & mask128, value & mask128];
}

export function combine128PartsTo256(high: bigint, low: bigint): bigint {
  return (high << 128n) | low;
}

/** ctUint256 = { ctUint128 ciphertextHigh, ctUint128 ciphertextLow } */
export function decodeCtUint256FromBytes(data: `0x${string}`): {
  ciphertextHigh: bigint;
  ciphertextLow: bigint;
} {
  const [decoded] = decodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { type: "uint256", name: "ciphertextHigh" },
          { type: "uint256", name: "ciphertextLow" },
        ],
      },
    ],
    data
  );
  const d = decoded as { ciphertextHigh: bigint; ciphertextLow: bigint };
  return d;
}

export function encodeCtUint256(ciphertextHigh: bigint, ciphertextLow: bigint): `0x${string}` {
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { type: "uint256", name: "ciphertextHigh" },
          { type: "uint256", name: "ciphertextLow" },
        ],
      },
    ],
    [{ ciphertextHigh, ciphertextLow }]
  );
}

/** itUint256 = { ctUint256 ciphertext, bytes signature } */
export function encodeItUint256(
  ciphertextHigh: bigint,
  ciphertextLow: bigint,
  signature: `0x${string}`
): `0x${string}` {
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          {
            type: "tuple",
            name: "ciphertext",
            components: [
              { type: "uint256", name: "ciphertextHigh" },
              { type: "uint256", name: "ciphertextLow" },
            ],
          },
          { type: "bytes", name: "signature" },
        ],
      },
    ],
    [{ ciphertext: { ciphertextHigh, ciphertextLow }, signature }]
  );
}
