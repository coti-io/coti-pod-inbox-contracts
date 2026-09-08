import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import {
  concat,
  decodeAbiParameters,
  encodeAbiParameters,
  encodePacked,
  keccak256,
  padHex,
  toHex,
  type Hex,
} from "viem";
import { sign } from "viem/accounts";
import { HARDHAT_ACCOUNT0_PK } from "./mpc-codec-helpers.js";

const MPC_PRECOMPILE = "0x0000000000000000000000000000000000000064" as const;
const IT_UINT64 = padHex("0x0e", { size: 8 });
const ALICE = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" as const;
const BOB = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
const ZERO32 = ("0x" + "00".repeat(32)) as Hex;

function encodeItUint64(ciphertext: bigint): Hex {
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
    [{ ciphertext, signature: "0x1234" }]
  );
}

function methodCall(itArg: Hex, trailer: Hex) {
  const argLen = BigInt((itArg.length - 2) / 2);
  return {
    selector: "0x12345678" as Hex,
    data: concat([itArg, trailer]),
    datatypes: [IT_UINT64],
    datalens: [toHex(argLen, { size: 32 })],
  };
}

async function trailerFor(ciphertext: bigint, user: `0x${string}`): Promise<Hex> {
  const digest = keccak256(encodePacked(["uint256", "address"], [ciphertext, user]));
  const raw = await sign({ hash: digest, privateKey: HARDHAT_ACCOUNT0_PK });
  return encodeAbiParameters(
    [{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
    [user, raw.r, raw.s]
  );
}

function rsOf(trailer: Hex): readonly [Hex, Hex] {
  const [, r, s] = decodeAbiParameters(
    [{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
    trailer
  );
  return [r as Hex, s as Hex];
}

describe("MpcAbiReEncode user bind (copied it*)", { concurrency: 1 }, async () => {
  const { viem } = await network.connect({ network: "hardhat" });
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const c = { public: publicClient, wallet };

  const mock = await viem.deployContract("MockExtendedOperations", [], { client: c });
  const mockCode = (await publicClient.getCode({ address: mock.address })) as Hex | undefined;
  await publicClient.request({
    method: "hardhat_setCode",
    params: [MPC_PRECOMPILE, mockCode ?? "0x"],
  });

  const reEncode = await viem.deployContract("MpcAbiReEncode", [], { client: c });
  const harness = await viem.deployContract("DelegateCodecHarness", [reEncode.address], {
    client: c,
  });

  const ciphertext = 42n;
  const itArg = encodeItUint64(ciphertext);

  const encode = (call: ReturnType<typeof methodCall>) =>
    publicClient.simulateContract({
      address: harness.address,
      abi: harness.abi,
      functionName: "encodeViaDelegate",
      args: [call],
      account: wallet.account,
    });

  it("encodes when the miner signed keccak(cts ‖ boundUser)", async () => {
    const result = await encode(methodCall(itArg, await trailerFor(ciphertext, ALICE)));
    assert.equal((result.result as Hex).slice(0, 10).toLowerCase(), "0x12345678");
  });

  it("reverts when alice's bind signature is replayed with boundUser=bob", async () => {
    const [r, s] = rsOf(await trailerFor(ciphertext, ALICE));
    const replayed = encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
      [BOB, r, s]
    );
    await assert.rejects(
      () => encode(methodCall(itArg, replayed)),
      (err: unknown) => /user sig|reverted/i.test(String(err))
    );
  });

  it("reverts on empty r,s trailer (cms miss for attacker op)", async () => {
    const empty = encodeAbiParameters(
      [{ type: "address" }, { type: "bytes32" }, { type: "bytes32" }],
      [BOB, ZERO32, ZERO32]
    );
    await assert.rejects(
      () => encode(methodCall(itArg, empty)),
      (err: unknown) => /user sig|reverted/i.test(String(err))
    );
  });
});
