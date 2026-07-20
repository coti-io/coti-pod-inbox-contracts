import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decodeAbiParameters,
  decodeEventLog,
  encodeFunctionData,
  keccak256,
  toHex,
} from "viem";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";

const receiptWaitOptions = { timeout: 300_000, pollingInterval: 2_000 };

const SOURCE_CHAIN_ID = 1000n;
const TARGET_CHAIN_ID = 1001n;
const GAS_PRICE_WEI = 1_000_000_000n;
const SEND_VALUE_WEI = 2_000_000_000_000_000n;
const PRICE_SCALE_18 = 10n ** 18n;
const MAX_ERROR_RETURN_DATA = 256n;
/** Large enough to exceed {MAX_ERROR_RETURN_DATA} while fitting under EDR's 2^24 gas cap. */
const LARGE_REVERT_SIZE = 8_192n;

const CONSTANT_FEE = {
  constantFee: 1n,
  gasPerByte: 0n,
  callbackExecutionGas: 0n,
  errorLength: 0n,
  bufferRatioX10000: 0n,
} as const;

const packRequestId = (source: bigint, target: bigint, nonce: bigint): `0x${string}` => {
  const packed = (source << 192n) | (target << 128n) | nonce;
  return toHex(packed, { size: 32 });
};

describe("Inbox POD-02 capped returndata", { concurrency: false, timeout: 600_000 }, () => {
  it("large target revert stores capped error and allows contiguous next nonce", async () => {
    const { viem } = await network.connect({
      network: "hardhat",
      override: { allowUnlimitedContractSize: true },
    });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;

    const inbox = await viem.deployContract("Inbox", [], {
      client: { public: publicClient, wallet },
    });
    await inbox.write.init([deployer, TARGET_CHAIN_ID], { account: deployer });
    await inbox.write.updateMinFeeConfigs([{ ...CONSTANT_FEE }, { ...CONSTANT_FEE }], {
      account: deployer,
    });
    await inbox.write.addMiner([deployer], { account: deployer });

    const oracle = await viem.deployContract("PriceOracle", [deployer], {
      client: { public: publicClient, wallet },
    });
    const { localToken, remoteToken } = oracleTokensForChain(31337);
    await oracle.write.setInboxTokens([localToken, remoteToken], { account: deployer });
    await oracle.write.setLocalTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await oracle.write.setRemoteTokenPriceUSD([PRICE_SCALE_18], { account: deployer });
    await inbox.write.setPriceOracle([oracle.address], { account: deployer });

    const boomTarget = await viem.deployContract("LargeRevertTarget", [], {
      client: { public: publicClient, wallet },
    });

    const boomCalldata = encodeFunctionData({
      abi: boomTarget.abi,
      functionName: "boom",
      args: [LARGE_REVERT_SIZE],
    });
    const okCalldata = encodeFunctionData({
      abi: boomTarget.abi,
      functionName: "ok",
      args: [],
    });

    const rawMethod = (data: `0x${string}`) => ({
      selector: "0x00000000" as `0x${string}`,
      data,
      datatypes: [] as `0x${string}`[],
      datalens: [] as `0x${string}`[],
    });

    const rid1 = packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, 1n);
    const rid2 = packRequestId(SOURCE_CHAIN_ID, TARGET_CHAIN_ID, 2n);

    const mineHash = await inbox.write.batchProcessRequests(
      [
        SOURCE_CHAIN_ID,
        [
          {
            requestId: rid1,
            sourceContract: deployer,
            targetContract: boomTarget.address,
            methodCall: rawMethod(boomCalldata),
            callbackSelector: "0x00000000",
            errorSelector: "0x00000000",
            isTwoWay: false,
            sourceRequestId: toHex(0n, { size: 32 }),
            targetFee: 5_000_000n,
            callerFee: 0n,
          },
          {
            requestId: rid2,
            sourceContract: deployer,
            targetContract: boomTarget.address,
            methodCall: rawMethod(okCalldata),
            callbackSelector: "0x00000000",
            errorSelector: "0x00000000",
            isTwoWay: false,
            sourceRequestId: toHex(0n, { size: 32 }),
            targetFee: 100_000n,
            callerFee: 0n,
          },
        ],
      ],
      { account: deployer, gas: 15_000_000n }
    );
    const receipt = await publicClient.waitForTransactionReceipt({
      hash: mineHash,
      ...receiptWaitOptions,
    });
    assert.equal(receipt.status, "success");

    const errTuple = (await inbox.read.errors([rid1])) as readonly [
      `0x${string}`,
      bigint,
      `0x${string}`,
    ];
    const [errRequestId, errorCode, errorMessage] = errTuple;
    assert.equal(errRequestId.toLowerCase(), rid1.toLowerCase());
    assert.equal(errorCode, 1n);
    assert.ok(errorMessage.length > 2, "error payload present");

    // Stored message must be far smaller than the raw revert blob.
    const storedBytes = (errorMessage.length - 2) / 2;
    assert.ok(
      storedBytes < 600,
      `stored error too large: ${storedBytes} bytes (expected capped abi.encode)`
    );

    const [prefixHash, fullLength, prefix] = decodeAbiParameters(
      [{ type: "bytes32" }, { type: "uint256" }, { type: "bytes" }],
      errorMessage
    );
    assert.equal(fullLength, LARGE_REVERT_SIZE);
    const prefixByteLen = BigInt((prefix.length - 2) / 2);
    assert.equal(prefixByteLen, MAX_ERROR_RETURN_DATA);
    assert.equal(prefixHash, keccak256(prefix));

    const incoming2 = (await inbox.read.getIncomingRequest([rid2])) as { executed: boolean };
    assert.equal(incoming2.executed, true);

    const lastId = (await inbox.read.lastIncomingRequestId([SOURCE_CHAIN_ID])) as `0x${string}`;
    assert.equal(lastId.toLowerCase(), rid2.toLowerCase());

    // ErrorReceived for rid1 should exist and be small.
    let sawError = false;
    for (const log of receipt.logs) {
      try {
        const decoded = decodeEventLog({
          abi: inbox.abi,
          data: log.data,
          topics: log.topics,
        });
        if (decoded.eventName === "ErrorReceived") {
          const args = decoded.args as { requestId: `0x${string}`; errorMessage: `0x${string}` };
          if (args.requestId.toLowerCase() === rid1.toLowerCase()) {
            sawError = true;
            assert.ok((args.errorMessage.length - 2) / 2 < 600);
          }
        }
      } catch {
        // not this event
      }
    }
    assert.equal(sawError, true);
  });
});
