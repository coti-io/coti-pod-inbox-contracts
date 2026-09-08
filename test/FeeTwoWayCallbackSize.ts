import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";

const TX_GAS_PRICE_WEI = 25_000_000_000n;
const PRICE_SCALE_18 = 10n ** 18n;
const VALIDATE_GAS = 5_000_000n;

/** Shipped Sepolia-side formula template (800 gas/byte, 1.5× buffer). */
const SEPOLIA_LOCAL = {
  constantFee: 0n,
  gasPerByte: 800n,
  callbackExecutionGas: 100_000n,
  errorLength: 256n,
  bufferRatioX10000: 5000n,
  maxMethodCallBytes: 8192n,
  maxExecutionGas: 5_000_000n,
  gasPriceMul: 1n,
  gasPriceDiv: 1n,
} as const;

const REMOTE_CONSTANT = {
  constantFee: 200_000n,
  gasPerByte: 0n,
  callbackExecutionGas: 0n,
  errorLength: 0n,
  bufferRatioX10000: 10_000n,
  maxMethodCallBytes: 8192n,
  maxExecutionGas: 5_000_000n,
  gasPriceMul: 1n,
  gasPriceDiv: 1n,
} as const;

function expectedMinFee(
  dataSize: bigint,
  cfg: {
    constantFee: bigint;
    gasPerByte: bigint;
    callbackExecutionGas: bigint;
    errorLength: bigint;
    bufferRatioX10000: bigint;
  }
): bigint {
  if (cfg.constantFee > 0n) return cfg.constantFee;
  const base =
    dataSize * cfg.gasPerByte + cfg.callbackExecutionGas + cfg.errorLength * cfg.gasPerByte;
  return (base * (10_000n + cfg.bufferRatioX10000)) / 10_000n;
}

async function deployProbe() {
  const { viem } = await network.connect({ network: "hardhat" });
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const deployer = wallet.account.address as `0x${string}`;
  const client = { public: publicClient, wallet };

  const feeManager = await viem.deployContract("FeeManager", [], { client });
  const probe = await viem.deployContract("FeeTwoWayProbe", [feeManager.address], { client });
  const oracle = await viem.deployContract("PriceOracle", [deployer], { client });
  const { localToken, remoteToken } = oracleTokensForChain(31337);
  const w = { account: deployer } as const;
  await oracle.write.setInboxTokens([localToken, remoteToken], w);
  await oracle.write.setLocalTokenPriceUSD([PRICE_SCALE_18], w);
  await oracle.write.setRemoteTokenPriceUSD([PRICE_SCALE_18], w);
  await probe.write.setPriceOracle([oracle.address], w);
  await probe.write.setGasPriceBounds([0n, TX_GAS_PRICE_WEI, TX_GAS_PRICE_WEI], w);
  await probe.write.updateMinFeeConfigs([{ ...SEPOLIA_LOCAL }, { ...REMOTE_CONSTANT }], w);
  return { probe, publicClient, deployer };
}

describe("Z-09 two-way callback size quote vs validate", { concurrency: false, timeout: 120_000 }, () => {
  it("exact two-size quote is accepted (auditor 1024 vs 100 + 50k exec)", async () => {
    const { probe, publicClient, deployer } = await deployProbe();

    const requestSize = 1024n;
    const callbackSize = 100n;
    const callbackExecGas = 50_000n;
    const gp = TX_GAS_PRICE_WEI;

    const quotedCallbackGas = expectedMinFee(callbackSize, SEPOLIA_LOCAL) + callbackExecGas;
    const oldValidatorFloor = expectedMinFee(requestSize, SEPOLIA_LOCAL);
    assert.equal(quotedCallbackGas, 627_200n);
    assert.equal(oldValidatorFloor, 1_686_000n);
    assert.ok(
      quotedCallbackGas < oldValidatorFloor,
      "pre-fix: exact quote was below outbound-size callback floor"
    );

    const [targetWei, callerWei] = await probe.read.calculateTwoWayFeeRequiredInLocalToken([
      requestSize,
      callbackSize,
      0n,
      callbackExecGas,
      gp,
    ]);
    assert.equal(callerWei, quotedCallbackGas * gp);

    const hash = await probe.write.validateTwoWayFees([requestSize, callerWei], {
      account: deployer,
      value: targetWei + callerWei,
      gasPrice: gp,
      gas: VALIDATE_GAS,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    assert.equal(receipt.status, "success");
  });

  it("callback below size-independent template min still reverts CallbackFeeTooLow", async () => {
    const { probe, deployer } = await deployProbe();
    const gp = TX_GAS_PRICE_WEI;
    const floorGas = expectedMinFee(0n, SEPOLIA_LOCAL);
    const [targetWei] = await probe.read.calculateTwoWayFeeRequiredInLocalToken([
      1024n,
      0n,
      0n,
      0n,
      gp,
    ]);
    const underCallbackWei = (floorGas - 1n) * gp;

    await assert.rejects(
      () =>
        probe.write.validateTwoWayFees([1024n, underCallbackWei], {
          account: deployer,
          value: targetWei + underCallbackWei,
          gasPrice: gp,
          gas: VALIDATE_GAS,
        }),
      (err: unknown) => String(err).includes("CallbackFeeTooLow")
    );
  });
});
