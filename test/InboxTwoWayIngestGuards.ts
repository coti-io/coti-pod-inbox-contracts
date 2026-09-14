import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { packRequestId } from "./packRequestId.js";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";
import { deployTestInbox, mpcAbiReEncodeOf, feeManagerOf } from "../scripts/deploy-test-inbox.js";
import { enableInboxAuth, mineArgs } from "../scripts/test-helpers/verifier.js";

const SOURCE_CHAIN_ID = 1000n;
const TARGET_CHAIN_ID = 1001n;
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

describe("two-way ingest field validation", {
  concurrency: false,
  timeout: 600_000,
}, () => {
  const setup = async () => {
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
    await enableInboxAuth(inbox, deployer);
    const oracle = await viem.deployContract("PriceOracle", [deployer], {
      client: { public: publicClient, wallet },
    });
    const { localToken, remoteToken } = oracleTokensForChain(31337);
    await oracle.write.setInboxTokens([localToken, remoteToken], { account: deployer });
    await oracle.write.setLocalTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await oracle.write.setRemoteTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await inbox.write.setPriceOracle([oracle.address], { account: deployer });
    return { inbox, deployer, publicClient, viem };
  };

  const baseMined = (deployer: `0x${string}`, overrides: Record<string, unknown> = {}) => ({
    requestId: packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, 1n),
    sourceContract: deployer,
    targetContract: deployer,
    methodCall: {
      selector: "0x00000000" as const,
      data: "0x" as `0x${string}`,
      datatypes: [] as const,
      datalens: [] as const,
    },
    callbackSelector: "0x11111111" as `0x${string}`,
    errorSelector: "0x22222222" as `0x${string}`,
    isTwoWay: true,
    sourceRequestId: ("0x" + "00".repeat(32)) as `0x${string}`,
    targetFee: 500_000n,
    callerFee: 100_000n,
    ...overrides,
  });

  it("rejects duplicate selectors at ingest", async () => {
    const { inbox, deployer } = await setup();
    await assert.rejects(
      async () =>
        inbox.write.batchProcessRequests(
          await mineArgs(inbox, SOURCE_CHAIN_ID, [
            baseMined(deployer, {
              callbackSelector: "0xaaaaaaaa",
              errorSelector: "0xaaaaaaaa",
            }),
          ]),
          { account: deployer, gas: 2_000_000n }
        ),
      /InvalidTwoWaySelectors/
    );
  });

  it("rejects zero errorSelector at ingest", async () => {
    const { inbox, deployer } = await setup();
    await assert.rejects(
      async () =>
        inbox.write.batchProcessRequests(
          await mineArgs(inbox, SOURCE_CHAIN_ID, [
            baseMined(deployer, { errorSelector: "0x00000000" }),
          ]),
          { account: deployer, gas: 2_000_000n }
        ),
      /InvalidTwoWaySelectors/
    );
  });

  it("still mines a well-formed two-way request", async () => {
    const { inbox, deployer, publicClient, viem } = await setup();
    const target = await viem.deployContract("InboxGasTarget", [inbox.address], {
      client: { public: publicClient, wallet: (await viem.getWalletClients())[0] },
    });
    const mined = baseMined(deployer, { targetContract: target.address });
    const hash = await inbox.write.batchProcessRequests(await mineArgs(inbox, SOURCE_CHAIN_ID, [mined]), {
      account: deployer,
      gas: 4_000_000n,
    });
    await publicClient.waitForTransactionReceipt({
      hash,
      timeout: 120_000,
      pollingInterval: 1_000,
    });
    const incoming = await inbox.read.incomingRequests([mined.requestId]);
    const storedId = (incoming as any).requestId ?? (incoming as any)[0];
    assert.equal(storedId, mined.requestId);
  });
});
