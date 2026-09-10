import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decodeErrorResult, decodeEventLog, encodeFunctionData } from "viem";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";
import { deployTestInbox, mpcAbiReEncodeOf, feeManagerOf } from "../scripts/deploy-test-inbox.js";
import { enableInboxAuth, mineArgs } from "../scripts/test-helpers/verifier.js";
import { packRequestId } from "./packRequestId.js";

const receiptWaitOptions = { timeout: 300_000, pollingInterval: 2_000 };

const SOURCE_CHAIN_ID = 1000n;
const TARGET_CHAIN_ID = 1001n;
const PRICE_SCALE_18 = 10n ** 18n;
const ZERO_ID = ("0x" + "00".repeat(32)) as `0x${string}`;
const ERROR_CODE_EXECUTION_FAILED = 1n;

/** Outer gas too small to forward `STARVE_FEE` after `POST_CALL_GAS_RESERVE`. */
const STARVE_GAS = 4_000_000n;
const STARVE_FEE = 5_000_000n;
const FAT_GAS = 16_000_000n;
const DELIVERED_FEE = 1_000_000n;
const OOG_FEE = 400_000n;

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

const Mode = {
  EmptySuccess: 5n,
  BurnUntilOog: 6n,
} as const;

const INSUFFICIENT_MINER_GAS_ABI = [
  {
    type: "error",
    name: "InsufficientMinerGas",
    inputs: [
      { name: "requestId", type: "bytes32" },
      { name: "gasForCall", type: "uint256" },
      { name: "targetGasBudget", type: "uint256" },
    ],
  },
] as const;

const ESTIMATE_ERROR_ABI = [
  {
    type: "error",
    name: "ExecutionGasEstimate",
    inputs: [
      { name: "gasUsed", type: "uint256" },
      { name: "responseDataSize", type: "uint256" },
      { name: "errorDataSize", type: "uint256" },
    ],
  },
] as const;

const revertData = (e: any): `0x${string}` | undefined => {
  const raw = e?.data ?? e?.cause?.data ?? e?.walk?.()?.data;
  const data = typeof raw === "string" ? raw : raw?.data;
  return typeof data === "string" ? (data as `0x${string}`) : undefined;
};

const incomingRequestId = async (inbox: any, requestId: `0x${string}`): Promise<`0x${string}`> => {
  const incoming = (await inbox.read.getIncomingRequest([requestId])) as any;
  return (incoming.requestId ?? incoming[0]) as `0x${string}`;
};

describe("inbox prepaid stipend precondition", {
  concurrency: false,
  timeout: 300_000,
}, () => {
  const setup = async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;

    const inbox = await deployTestInbox(viem, { client: { public: publicClient, wallet } });
    await inbox.write.init(
      [deployer, TARGET_CHAIN_ID, mpcAbiReEncodeOf(inbox), feeManagerOf(inbox)],
      { account: deployer }
    );
    await inbox.write.updateMinFeeConfigs([{ ...FEE }, { ...FEE }], { account: deployer });
    await inbox.write.addMiner([deployer], { account: deployer });
    await enableInboxAuth(inbox, deployer);

    const oracle = await viem.deployContract("PriceOracle", [deployer], {
      client: { public: publicClient, wallet },
    });
    const { localToken, remoteToken } = oracleTokensForChain(31337);
    await oracle.write.setInboxTokens([localToken, remoteToken], { account: deployer });
    await oracle.write.setLocalTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await oracle.write.setRemoteTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await inbox.write.setPriceOracle([oracle.address], { account: deployer });

    const gasTarget = await viem.deployContract("AdversarialGasTarget", [inbox.address], {
      client: { public: publicClient, wallet },
    });
    const revertTarget = await viem.deployContract("LargeRevertTarget", [], {
      client: { public: publicClient, wallet },
    });
    return { inbox, gasTarget, revertTarget, deployer, publicClient };
  };

  const entryCall = () =>
    encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "entry",
          inputs: [{ name: "data", type: "bytes" }],
          outputs: [],
          stateMutability: "nonpayable",
        },
      ],
      functionName: "entry",
      args: ["0x"],
    });

  const minedFor = (params: {
    requestId: `0x${string}`;
    deployer: `0x${string}`;
    target: `0x${string}`;
    data: `0x${string}`;
    targetFee: bigint;
    isTwoWay?: boolean;
  }) => ({
    requestId: params.requestId,
    sourceContract: params.deployer,
    targetContract: params.target,
    methodCall: {
      selector: "0x00000000" as `0x${string}`,
      data: params.data,
      datatypes: [] as `0x${string}`[],
      datalens: [] as `0x${string}`[],
    },
    callbackSelector: "0x11111111" as `0x${string}`,
    errorSelector: "0x22222222" as `0x${string}`,
    isTwoWay: params.isTwoWay ?? false,
    sourceRequestId: ZERO_ID,
    targetFee: params.targetFee,
    callerFee: 0n,
  });

  const mine = async (params: {
    inbox: any;
    publicClient: any;
    deployer: `0x${string}`;
    mined: ReturnType<typeof minedFor>;
    gas: bigint;
  }) => {
    const hash = await params.inbox.write.batchProcessRequests(
      await mineArgs(params.inbox, SOURCE_CHAIN_ID, [params.mined]),
      { account: params.deployer, gas: params.gas }
    );
    const receipt = await params.publicClient.waitForTransactionReceipt({
      hash,
      ...receiptWaitOptions,
    });
    assert.equal(receipt.status, "success");
    return receipt;
  };

  const sawSystemError = (receipt: { logs: readonly { address: string; data: `0x${string}`; topics: readonly `0x${string}`[] }[] }, inbox: any, code: bigint) => {
    let found = false;
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== inbox.address.toLowerCase()) continue;
      try {
        const decoded = decodeEventLog({ abi: inbox.abi, data: log.data, topics: log.topics });
        if (decoded.eventName === "SystemErrorRaised" && decoded.args.errorCode === code) {
          found = true;
        }
      } catch {
        // ignore
      }
    }
    return found;
  };

  it("starved mine reverts InsufficientMinerGas; remine with fat gas succeeds", async () => {
    const { inbox, gasTarget, deployer, publicClient } = await setup();
    await gasTarget.write.configure([Mode.EmptySuccess, 0n, 0n, "0x"], { account: deployer });

    const requestId = packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, 1n);
    const mined = minedFor({
      requestId,
      deployer,
      target: gasTarget.address,
      data: entryCall(),
      targetFee: STARVE_FEE,
    });

    const starvedArgs = await mineArgs(inbox, SOURCE_CHAIN_ID, [mined]);
    await assert.rejects(
      () =>
        inbox.write.batchProcessRequests(starvedArgs, {
          account: deployer,
          gas: STARVE_GAS,
        }),
      (e: any) => {
        const data = revertData(e);
        assert.ok(data, `missing revert data: ${String(e)}`);
        const decoded = decodeErrorResult({ abi: INSUFFICIENT_MINER_GAS_ABI, data });
        assert.equal(decoded.errorName, "InsufficientMinerGas");
        const [rid, gasForCall, targetGasBudget] = decoded.args as [string, bigint, bigint];
        assert.equal(rid.toLowerCase(), requestId.toLowerCase());
        assert.ok(gasForCall < targetGasBudget, "gasForCall must be below prepaid budget");
        assert.equal(targetGasBudget, STARVE_FEE);
        return true;
      }
    );

    assert.equal(await incomingRequestId(inbox, requestId), ZERO_ID);
    assert.equal(await inbox.read.lastIncomingRequestId([SOURCE_CHAIN_ID]), ZERO_ID);

    await mine({ inbox, publicClient, deployer, mined, gas: FAT_GAS });
    const incoming = (await inbox.read.getIncomingRequest([requestId])) as any;
    assert.equal(String(incoming.requestId).toLowerCase(), requestId.toLowerCase());
    assert.equal(incoming.executed, true);
    const err = (await inbox.read.errors([requestId])) as readonly [`0x${string}`, bigint, `0x${string}`];
    assert.equal(err[1], 0n);
  });

  it("cheap revert is InsufficientMinerGas when starved and ErrorReceived when prepaid is delivered", async () => {
    const { inbox, revertTarget, deployer, publicClient } = await setup();
    const boom = encodeFunctionData({
      abi: revertTarget.abi,
      functionName: "boomEmpty",
      args: [],
    });
    const ok = encodeFunctionData({
      abi: revertTarget.abi,
      functionName: "ok",
      args: [],
    });

    const starvedId = packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, 1n);
    const starved = minedFor({
      requestId: starvedId,
      deployer,
      target: revertTarget.address,
      data: boom,
      targetFee: STARVE_FEE,
    });
    const starvedArgs = await mineArgs(inbox, SOURCE_CHAIN_ID, [starved]);
    await assert.rejects(
      () =>
        inbox.write.batchProcessRequests(starvedArgs, {
          account: deployer,
          gas: STARVE_GAS,
        }),
      /InsufficientMinerGas/
    );
    assert.equal(await incomingRequestId(inbox, starvedId), ZERO_ID);

    const deliveredId = packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, 1n);
    const delivered = minedFor({
      requestId: deliveredId,
      deployer,
      target: revertTarget.address,
      data: boom,
      targetFee: DELIVERED_FEE,
    });
    const receipt = await mine({
      inbox,
      publicClient,
      deployer,
      mined: delivered,
      gas: FAT_GAS,
    });
    assert.ok(
      receipt.logs.some((log: { topics: readonly string[] }) => log.topics.length >= 3),
      "expected ErrorReceived / MessageReceived logs"
    );
    const incoming = (await inbox.read.getIncomingRequest([deliveredId])) as any;
    assert.equal(incoming.executed, true);
    const err = (await inbox.read.errors([deliveredId])) as readonly [`0x${string}`, bigint, `0x${string}`];
    assert.equal(err[1], ERROR_CODE_EXECUTION_FAILED);
    assert.equal(sawSystemError(receipt, inbox, ERROR_CODE_EXECUTION_FAILED), true);

    const nextId = packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, 2n);
    await mine({
      inbox,
      publicClient,
      deployer,
      mined: minedFor({
        requestId: nextId,
        deployer,
        target: revertTarget.address,
        data: ok,
        targetFee: DELIVERED_FEE,
      }),
      gas: FAT_GAS,
    });
    const next = (await inbox.read.getIncomingRequest([nextId])) as any;
    assert.equal(next.executed, true);
    const nextErr = (await inbox.read.errors([nextId])) as readonly [`0x${string}`, bigint, `0x${string}`];
    assert.equal(nextErr[1], 0n);
  });

  it("prepaid-delivered OOG commits ErrorReceived and is not remineable", async () => {
    const { inbox, gasTarget, deployer, publicClient } = await setup();
    await gasTarget.write.configure([Mode.BurnUntilOog, 0n, 0n, "0x"], { account: deployer });

    const requestId = packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, 1n);
    const mined = minedFor({
      requestId,
      deployer,
      target: gasTarget.address,
      data: entryCall(),
      targetFee: OOG_FEE,
    });
    const receipt = await mine({ inbox, publicClient, deployer, mined, gas: FAT_GAS });

    const incoming = (await inbox.read.getIncomingRequest([requestId])) as any;
    assert.equal(incoming.executed, true);
    const err = (await inbox.read.errors([requestId])) as readonly [`0x${string}`, bigint, `0x${string}`];
    assert.equal(err[1], ERROR_CODE_EXECUTION_FAILED);
    assert.equal(sawSystemError(receipt, inbox, ERROR_CODE_EXECUTION_FAILED), true);
    assert.equal(await inbox.read.lastIncomingRequestId([SOURCE_CHAIN_ID]), requestId);

    const remineArgs = await mineArgs(inbox, SOURCE_CHAIN_ID, [mined]);
    await assert.rejects(
      () =>
        inbox.write.batchProcessRequests(remineArgs, {
          account: deployer,
          gas: FAT_GAS,
        }),
      /NoncesNotContiguous/
    );

    const nextId = packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, 2n);
    await gasTarget.write.configure([Mode.EmptySuccess, 0n, 0n, "0x"], { account: deployer });
    await mine({
      inbox,
      publicClient,
      deployer,
      mined: minedFor({
        requestId: nextId,
        deployer,
        target: gasTarget.address,
        data: entryCall(),
        targetFee: DELIVERED_FEE,
      }),
      gas: FAT_GAS,
    });
    assert.equal(await inbox.read.lastIncomingRequestId([SOURCE_CHAIN_ID]), nextId);
  });

  it("starved encode-shaped payload reverts InsufficientMinerGas; does not ingest", async () => {
    const { inbox, gasTarget, deployer } = await setup();
    const requestId = packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, 1n);
    const mined = minedFor({
      requestId,
      deployer,
      target: gasTarget.address,
      data: entryCall(),
      targetFee: STARVE_FEE,
    });
    mined.methodCall = {
      selector: "0x00000000" as `0x${string}`,
      data: "0x",
      datatypes: ["0x0000000000000001" as `0x${string}`],
      datalens: [] as `0x${string}`[],
    };
    const starvedArgs = await mineArgs(inbox, SOURCE_CHAIN_ID, [mined]);
    await assert.rejects(
      () =>
        inbox.write.batchProcessRequests(starvedArgs, {
          account: deployer,
          gas: STARVE_GAS,
        }),
      /InsufficientMinerGas/
    );
    assert.equal(await incomingRequestId(inbox, requestId), ZERO_ID);
    assert.equal(await inbox.read.lastIncomingRequestId([SOURCE_CHAIN_ID]), ZERO_ID);
  });

  it("starved tail reverts the whole batch; prefix is not ingested", async () => {
    const { inbox, gasTarget, deployer } = await setup();
    await gasTarget.write.configure([Mode.EmptySuccess, 0n, 0n, "0x"], { account: deployer });
    const firstId = packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, 1n);
    const secondId = packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, 2n);
    const first = minedFor({
      requestId: firstId,
      deployer,
      target: gasTarget.address,
      data: entryCall(),
      targetFee: DELIVERED_FEE,
    });
    const second = minedFor({
      requestId: secondId,
      deployer,
      target: gasTarget.address,
      data: entryCall(),
      targetFee: STARVE_FEE,
    });
    const args = await mineArgs(inbox, SOURCE_CHAIN_ID, [first, second]);
    await assert.rejects(
      () =>
        inbox.write.batchProcessRequests(args, {
          account: deployer,
          gas: 5_500_000n,
        }),
      /InsufficientMinerGas/
    );
    assert.equal(await incomingRequestId(inbox, firstId), ZERO_ID);
    assert.equal(await incomingRequestId(inbox, secondId), ZERO_ID);
    assert.equal(await inbox.read.lastIncomingRequestId([SOURCE_CHAIN_ID]), ZERO_ID);
  });

  it("estimateExecutionGasForMiner still reverts ExecutionGasEstimate, not InsufficientMinerGas", async () => {
    const { inbox, gasTarget, deployer, publicClient } = await setup();
    await gasTarget.write.configure([Mode.EmptySuccess, 0n, 0n, "0x"], { account: deployer });

    const mined = minedFor({
      requestId: packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, 1n),
      deployer,
      target: gasTarget.address,
      data: entryCall(),
      targetFee: STARVE_FEE,
    });

    try {
      await publicClient.simulateContract({
        address: inbox.address,
        abi: inbox.abi,
        functionName: "estimateExecutionGasForMiner",
        args: [SOURCE_CHAIN_ID, mined, 1_000_000n],
        account: deployer,
      });
      assert.fail("expected estimate revert");
    } catch (e: any) {
      const data = revertData(e);
      assert.ok(data, `missing revert data: ${String(e)}`);
      const decoded = decodeErrorResult({ abi: ESTIMATE_ERROR_ABI, data });
      assert.equal(decoded.errorName, "ExecutionGasEstimate");
      assert.ok((decoded.args[0] as bigint) > 0n);
    }

    assert.equal(
      await incomingRequestId(inbox, mined.requestId),
      ZERO_ID
    );
  });
});
