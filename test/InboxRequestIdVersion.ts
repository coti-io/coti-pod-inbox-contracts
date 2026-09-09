import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { toHex } from "viem";
import { network } from "hardhat";
import { deployTestInbox, mpcAbiReEncodeOf, feeManagerOf } from "../scripts/deploy-test-inbox.js";
import { packRequestId, REQUEST_ID_VERSION } from "./packRequestId.js";

const SOURCE_CHAIN_ID = 1000n;
const TARGET_CHAIN_ID = 1001n;

const FEE = {
  constantFee: 1n,
  gasPerByte: 0n,
  callbackExecutionGas: 0n,
  errorLength: 0n,
  bufferRatioX10000: 0n,
  maxMethodCallBytes: 8192n,
  maxExecutionGas: 5_000_000n,
  gasPriceMul: 1n,
  gasPriceDiv: 1n,
} as const;

describe("request id Inbox generation", { concurrency: false, timeout: 600_000 }, () => {
  it("getRequestId embeds generation and unpack strips it from the nonce", async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;

    const inbox = await deployTestInbox(viem, { client: { public: publicClient, wallet } });
    await inbox.write.init([deployer, TARGET_CHAIN_ID, mpcAbiReEncodeOf(inbox), feeManagerOf(inbox)], {
      account: deployer,
    });

    const onChainVersion = await inbox.read.REQUEST_ID_VERSION();
    assert.equal(BigInt(onChainVersion as number | bigint), REQUEST_ID_VERSION);

    const id = (await inbox.read.getRequestId([SOURCE_CHAIN_ID, TARGET_CHAIN_ID, 7n])) as `0x${string}`;
    assert.equal(id, packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, 7n));

    const [src, tgt, nonce] = (await inbox.read.unpackRequestId([id])) as [bigint, bigint, bigint];
    assert.equal(src, SOURCE_CHAIN_ID);
    assert.equal(tgt, TARGET_CHAIN_ID);
    assert.equal(nonce, 7n);
  });

  it("rejects mining a request id with the wrong generation byte", async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;

    const inbox = await deployTestInbox(viem, { client: { public: publicClient, wallet } });
    await inbox.write.init([deployer, TARGET_CHAIN_ID, mpcAbiReEncodeOf(inbox), feeManagerOf(inbox)], {
      account: deployer,
    });
    await inbox.write.updateMinFeeConfigs([{ ...FEE }, { ...FEE }], { account: deployer });
    await inbox.write.addMiner([deployer], { account: deployer });

    // Legacy layout: no generation byte (version nibble = 0).
    const legacyId = toHex((SOURCE_CHAIN_ID << 192n) | (TARGET_CHAIN_ID << 128n) | 1n, { size: 32 });
    const mined = {
      requestId: legacyId,
      sourceContract: deployer,
      targetContract: deployer,
      methodCall: {
        selector: "0x00000000" as const,
        data: "0x" as `0x${string}`,
        datatypes: [] as const,
        datalens: [] as const,
      },
      callbackSelector: "0x00000000" as `0x${string}`,
      errorSelector: "0x00000000" as `0x${string}`,
      isTwoWay: false,
      sourceRequestId: ("0x" + "00".repeat(32)) as `0x${string}`,
      targetFee: 1n,
      callerFee: 0n,
    };

    await assert.rejects(
      () =>
        inbox.write.batchProcessRequests([SOURCE_CHAIN_ID, [mined]], {
          account: deployer,
          gas: 2_000_000n,
        }),
      /RequestIdVersionMismatch/
    );
  });
});
