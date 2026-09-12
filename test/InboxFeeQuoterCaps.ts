import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";

/** Minimal FeeConfig matching InboxFeeQuoter packing (identity skew). */
const baseConfig = {
  constantFee: 100_000n,
  gasPerByte: 0n,
  callbackExecutionGas: 0n,
  errorLength: 0n,
  bufferRatioX10000: 0n,
  maxMethodCallBytes: 10_000n,
  maxExecutionGas: 5_000_000n,
  gasPriceMul: 1n,
  gasPriceDiv: 1n,
};

describe("InboxFeeQuoter exec-gas cap", { concurrency: false, timeout: 600_000 }, () => {
  it("reverts when remote min + exec gas exceeds maxExecutionGas", { timeout: 300_000 }, async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const quoter = await viem.deployContract("InboxFeeQuoter", [], {
      client: { public: publicClient, wallet },
    });

    const overCapExec = 5_000_001n; // constantFee 100k would also push over, but exec alone exceeds
    await assert.rejects(
      () =>
        quoter.read.calculateTwoWayFeeRequiredInLocalToken([
          baseConfig,
          { ...baseConfig, constantFee: 0n, maxExecutionGas: 5_000_000n },
          1n,
          1n,
          0n,
          0n,
          overCapExec,
          0n,
          1_000_000_000n,
        ]),
      /FeeGasTooHigh/
    );
  });

  it("quotes when remote min + exec gas is under maxExecutionGas", { timeout: 300_000 }, async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const quoter = await viem.deployContract("InboxFeeQuoter", [], {
      client: { public: publicClient, wallet },
    });

    const remote = { ...baseConfig, constantFee: 100_000n, maxExecutionGas: 5_000_000n };
    const execGas = 200_000n;
    const gp = 1_000_000_000n;
    const [targetWei, callerWei] = await quoter.read.calculateTwoWayFeeRequiredInLocalToken([
      baseConfig,
      remote,
      1n,
      1n,
      0n,
      0n,
      execGas,
      execGas,
      gp,
    ]);

    assert.equal(targetWei, (100_000n + execGas) * gp);
    assert.equal(callerWei, (100_000n + execGas) * gp);
  });
});
