import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { deployTestInbox, mpcAbiReEncodeOf, feeManagerOf } from "../scripts/deploy-test-inbox.js";

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

describe("Variable fee floor vs maxExecutionGas", { concurrency: false, timeout: 1_200_000 }, () => {
  it("rejects variable fee when expectedMinFee(0) is not below maxExecutionGas", { timeout: 600_000 }, async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;
    const inbox = await deployTestInbox(viem, { client: { public: publicClient, wallet } });
    await inbox.write.init([deployer, 1000n, mpcAbiReEncodeOf(inbox), feeManagerOf(inbox)], { account: deployer });
    // floor = (4_000_000 + 1*1) * (10000+10000)/10000 = 8_000_002 >= maxExecutionGas 5_000_000
    const bad = {
      constantFee: 0n,
      gasPerByte: 1n,
      callbackExecutionGas: 4_000_000n,
      errorLength: 1n,
      bufferRatioX10000: 10_000n,
      maxMethodCallBytes: 8192n,
      maxExecutionGas: 5_000_000n,
      gasPriceMul: 1n,
      gasPriceDiv: 1n,
    };
    await assert.rejects(
      () => inbox.write.updateMinFeeConfigs([{ ...bad }, { ...FEE }], { account: deployer }),
      /FeeConfigInvalid/
    );
  });

  it("accepts variable fee when expectedMinFee(0) is below maxExecutionGas", { timeout: 600_000 }, async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;
    const inbox = await deployTestInbox(viem, { client: { public: publicClient, wallet } });
    await inbox.write.init([deployer, 1000n, mpcAbiReEncodeOf(inbox), feeManagerOf(inbox)], { account: deployer });
    // floor = (100_000 + 300*10) * 3 = 309_000 < 5_000_000
    const ok = {
      constantFee: 0n,
      gasPerByte: 10n,
      callbackExecutionGas: 100_000n,
      errorLength: 300n,
      bufferRatioX10000: 20_000n,
      maxMethodCallBytes: 8192n,
      maxExecutionGas: 5_000_000n,
      gasPriceMul: 1n,
      gasPriceDiv: 1n,
    };
    await inbox.write.updateMinFeeConfigs([{ ...ok }, { ...FEE }], { account: deployer });
  });
});
