import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { packRequestId } from "./packRequestId.js";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";
import { deployTestInbox, mpcAbiReEncodeOf, feeManagerOf } from "../scripts/deploy-test-inbox.js";

const receiptWaitOptions = { timeout: 300_000, pollingInterval: 2_000 };

const SOURCE_CHAIN_ID = 1000n;
const TARGET_CHAIN_ID = 1001n;
const PRICE_SCALE_18 = 10n ** 18n;
const ERROR_CODE_EXECUTION_FAILED = 1n;

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

describe("empty-code target execution", {
  concurrency: false,
  timeout: 300_000,
}, () => {
  it("records EXECUTION_FAILED for a codeless target so retry remains reachable", async () => {
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

    const oracle = await viem.deployContract("PriceOracle", [deployer], {
      client: { public: publicClient, wallet },
    });
    const { localToken, remoteToken } = oracleTokensForChain(31337);
    await oracle.write.setInboxTokens([localToken, remoteToken], { account: deployer });
    await oracle.write.setLocalTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await oracle.write.setRemoteTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await inbox.write.setPriceOracle([oracle.address], { account: deployer });

    // Fresh EOA with no code — CALL would otherwise report success.
    const [, other] = await viem.getWalletClients();
    const emptyTarget = other.account.address as `0x${string}`;
    const code = await publicClient.getCode({ address: emptyTarget });
    assert.ok(!code || code === "0x", "fixture target must have no code");

    const requestId = packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, 1n);
    const methodCall = {
      selector: "0x00000000" as `0x${string}`,
      data: "0x" as `0x${string}`,
      datatypes: [] as `0x${string}`[],
      datalens: [] as `0x${string}`[],
    };
    const hash = await inbox.write.batchProcessRequests(
      [
        SOURCE_CHAIN_ID,
        [
          {
            requestId,
            sourceContract: deployer,
            targetContract: emptyTarget,
            methodCall,
            callbackSelector: "0x11111111",
            errorSelector: "0x22222222",
            isTwoWay: true,
            sourceRequestId: ("0x" + "00".repeat(32)) as `0x${string}`,
            targetFee: 1_000_000n,
            callerFee: 100_000n,
          },
        ],
      ],
      { account: deployer, gas: 4_000_000n }
    );
    await publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });

    const incoming = await inbox.read.incomingRequests([requestId]);
    assert.equal(Boolean((incoming as any).executed ?? (incoming as any)[10]), true);

    const err = await inbox.read.errors([requestId]);
    assert.equal(BigInt((err as any).errorCode ?? (err as any)[1]), ERROR_CODE_EXECUTION_FAILED);

    // Retry should be admitted (still EXECUTION_FAILED); it will fail again on empty code.
    await assert.rejects(
      () => inbox.write.retryFailedRequest([requestId], { account: deployer, gas: 4_000_000n }),
      /RetryFailedRequestExecutionFailed/
    );
    const errAfter = await inbox.read.errors([requestId]);
    assert.equal(
      BigInt((errAfter as any).errorCode ?? (errAfter as any)[1]),
      ERROR_CODE_EXECUTION_FAILED
    );
  });
});
