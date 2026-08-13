/**
 * Red PoCs for POST_FIX_INBOX_AUDIT_2026-08-13.md (inbox-side findings).
 * Each test states the safe behavior and currently FAILS on HEAD.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { concat, padHex, size } from "viem";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";
import { deployTestInbox, mpcAbiReEncodeOf, feeManagerOf } from "../scripts/deploy-test-inbox.js";

const receiptWaitOptions = { timeout: 300_000, pollingInterval: 2_000 };

const SOURCE_CHAIN_ID = 1000n;
const TARGET_CHAIN_ID = 1001n;
const GAS_PRICE_WEI = 1_000_000_000n;
const SEND_VALUE_WEI = 2_000_000_000_000_000n;
const PRICE_SCALE_18 = 10n ** 18n;

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

const minimalMethodCall = (dataHex: `0x${string}` = "0x") => ({
  selector: "0x00000000" as `0x${string}`,
  data: dataHex,
  datatypes: [] as `0x${string}`[],
  datalens: [] as `0x${string}`[],
});

const toMined = (r: any) => ({
  requestId: r.requestId as `0x${string}`,
  sourceContract: r.originalSender as `0x${string}`,
  targetContract: r.targetContract as `0x${string}`,
  methodCall: r.methodCall,
  callbackSelector: r.callbackSelector as `0x${string}`,
  errorSelector: r.errorSelector as `0x${string}`,
  isTwoWay: r.isTwoWay as boolean,
  sourceRequestId: r.sourceRequestId as `0x${string}`,
  targetFee: r.targetFee as bigint,
  callerFee: r.callerFee as bigint,
});

describe("Audit findings (inbox) — expected to FAIL until fixed", {
  concurrency: false,
  timeout: 600_000,
}, () => {
  const connect = async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;
    return { viem, publicClient, wallet, deployer };
  };

  const deployPair = async () => {
    const env = await connect();
    const { viem, publicClient, wallet, deployer } = env;

    const source = await deployTestInbox(viem, { client: { public: publicClient, wallet } });
    await source.write.init([deployer, SOURCE_CHAIN_ID, mpcAbiReEncodeOf(source), feeManagerOf(source)], {
      account: deployer,
    });
    await source.write.updateMinFeeConfigs([{ ...FEE }, { ...FEE }], { account: deployer });
    await source.write.addMiner([deployer], { account: deployer });

    const target = await deployTestInbox(viem, { client: { public: publicClient, wallet } });
    await target.write.init([deployer, TARGET_CHAIN_ID, mpcAbiReEncodeOf(target), feeManagerOf(target)], {
      account: deployer,
    });
    await target.write.updateMinFeeConfigs([{ ...FEE }, { ...FEE }], { account: deployer });
    await target.write.addMiner([deployer], { account: deployer });

    const oracle = await viem.deployContract("PriceOracle", [deployer], {
      client: { public: publicClient, wallet },
    });
    const { localToken, remoteToken } = oracleTokensForChain(31337);
    await oracle.write.setInboxTokens([localToken, remoteToken], { account: deployer });
    await oracle.write.setLocalTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await oracle.write.setRemoteTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await source.write.setPriceOracle([oracle.address], { account: deployer });
    await target.write.setPriceOracle([oracle.address], { account: deployer });

    return { ...env, source, target };
  };

  it("L1: honest relay of a 34-byte 0xff raw payload must execute, not miner-reject", async () => {
    const { source, target, deployer, publicClient } = await deployPair();
    const colliding = concat(["0xff", "0x07", padHex("0x01", { size: 32 })]) as `0x${string}`;
    assert.equal(size(colliding), 34);

    const hash = await source.write.sendOneWayMessage(
      [TARGET_CHAIN_ID, deployer, minimalMethodCall(colliding), "0x00000000"],
      { account: deployer, value: SEND_VALUE_WEI, gasPrice: GAS_PRICE_WEI }
    );
    await publicClient.waitForTransactionReceipt({ hash, ...receiptWaitOptions });
    const reqs = (await source.read.getRequests([TARGET_CHAIN_ID, 0n, 1n])) as any[];
    const mined = toMined(reqs[0]);
    assert.equal(size(mined.methodCall.data), 34);

    await target.write.batchProcessRequests([SOURCE_CHAIN_ID, [mined]], {
      account: deployer,
      gas: 10_000_000n,
    });

    const incoming = (await target.read.getIncomingRequest([mined.requestId])) as any;
    assert.equal(incoming.executed, true);
    assert.equal(incoming.methodCall.data.toLowerCase(), colliding.toLowerCase());

    const err = (await target.read.errors([mined.requestId])) as any;
    const errorCode = err.errorCode ?? err[1];
    assert.notEqual(errorCode, 3n, "user payload must not be classified as ERROR_CODE_MINER_REJECTED");
  });

  it("L3: on-chain FeeConfig must reject uint32-max maxMethodCallBytes (no protocol ceiling today)", async () => {
    const { viem, publicClient, wallet, deployer } = await connect();
    const inbox = await deployTestInbox(viem, { client: { public: publicClient, wallet } });
    await inbox.write.init([deployer, SOURCE_CHAIN_ID, mpcAbiReEncodeOf(inbox), feeManagerOf(inbox)], {
      account: deployer,
    });
    const unbounded = { ...FEE, maxMethodCallBytes: 0xffffffffn };
    await assert.rejects(
      () => inbox.write.updateMinFeeConfigs([{ ...unbounded }, { ...unbounded }], { account: deployer }),
      /FeeConfigInvalid|MethodCallTooLarge|revert/i
    );
  });

  it("L4: updateMinFeeConfigs and setMaxMessageLife must emit an observable log", async () => {
    const { viem, publicClient, wallet, deployer } = await connect();
    const inbox = await deployTestInbox(viem, { client: { public: publicClient, wallet } });
    await inbox.write.init([deployer, SOURCE_CHAIN_ID, mpcAbiReEncodeOf(inbox), feeManagerOf(inbox)], {
      account: deployer,
    });

    const feeHash = await inbox.write.updateMinFeeConfigs([{ ...FEE }, { ...FEE }], { account: deployer });
    const feeReceipt = await publicClient.waitForTransactionReceipt({ hash: feeHash, ...receiptWaitOptions });
    assert.ok(
      feeReceipt.logs.length > 0,
      "updateMinFeeConfigs left no logs — indexers cannot observe cap changes"
    );

    const lifeHash = await inbox.write.setMaxMessageLife([86400], { account: deployer });
    const lifeReceipt = await publicClient.waitForTransactionReceipt({ hash: lifeHash, ...receiptWaitOptions });
    assert.ok(
      lifeReceipt.logs.length > 0,
      "setMaxMessageLife left no logs — indexers cannot observe TTL changes"
    );
  });
});
