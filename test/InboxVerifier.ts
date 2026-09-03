import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { concat, toHex, type Hex } from "viem";
import { network } from "hardhat";
import { deployTestInbox, mpcAbiReEncodeOf, feeManagerOf } from "../scripts/deploy-test-inbox.js";
import {
  HARDHAT_VERIFIER_PK,
  enableInboxAuth,
  mineArgs,
  signVerifierBatch,
} from "../scripts/test-helpers/verifier.js";

const SOURCE_CHAIN_ID = 11155111n;
const ZERO_SIG = ("0x" + "11".repeat(65)) as Hex;

describe("Inbox verifier", { concurrency: 1 }, async function () {
  const { viem } = await network.connect({ network: "hardhat" });
  const publicClient = await viem.getPublicClient();
  const [wallet] = await viem.getWalletClients();
  const deployer = wallet.account.address as `0x${string}`;

  let inbox: any;

  const deployFresh = async () => {
    const deployed = await deployTestInbox(viem, {
      client: { public: publicClient, wallet },
    });
    await deployed.write.init([deployer, 0n, mpcAbiReEncodeOf(deployed), feeManagerOf(deployed)], {
      account: deployer,
    });
    await deployed.write.addMiner([deployer], { account: deployer });
    return deployed;
  };

  before(async function () {
    inbox = await deployFresh();
    await enableInboxAuth(inbox, deployer);
  });

  it("reverts VerifierNotSet when verifier is unset", async function () {
    const fresh = await deployFresh();
    const sig = await signVerifierBatch(fresh, SOURCE_CHAIN_ID, [], HARDHAT_VERIFIER_PK);
    await assert.rejects(
      fresh.write.batchProcessRequests([SOURCE_CHAIN_ID, [], sig], { account: deployer }),
      /VerifierNotSet/
    );
  });

  it("reverts InvalidVerifierSignature on a junk 65-byte sig", async function () {
    await assert.rejects(
      inbox.write.batchProcessRequests([SOURCE_CHAIN_ID, [], ZERO_SIG], { account: deployer }),
      /InvalidVerifierSignature/
    );
  });

  it("happy path: empty batch with a valid verifier sig succeeds", async function () {
    const hash = await inbox.write.batchProcessRequests(await mineArgs(inbox, SOURCE_CHAIN_ID, []), {
      account: deployer,
    });
    assert.ok(typeof hash === "string" && hash.startsWith("0x"));
  });

  it("reverts InvalidVerifierSignature when mined is mutated after signing", async function () {
    const emptySig = await signVerifierBatch(inbox, SOURCE_CHAIN_ID, []);
    const mutated = [
      {
        requestId: toHex(1n, { size: 32 }),
        sourceContract: deployer,
        targetContract: deployer,
        methodCall: {
          selector: "0x00000000" as Hex,
          data: "0x" as Hex,
          datatypes: [] as readonly Hex[],
          datalens: [] as readonly Hex[],
        },
        callbackSelector: "0x00000000" as Hex,
        errorSelector: "0x00000000" as Hex,
        isTwoWay: false,
        sourceRequestId: toHex(0n, { size: 32 }),
        targetFee: 0n,
        callerFee: 0n,
      },
    ];
    await assert.rejects(
      inbox.write.batchProcessRequests([SOURCE_CHAIN_ID, mutated, emptySig], { account: deployer }),
      /InvalidVerifierSignature/
    );
    const good = await signVerifierBatch(inbox, SOURCE_CHAIN_ID, []);
    const flipped = concat([good.slice(0, -2) as Hex, good.endsWith("1b") ? "0x1c" : "0x1b"]);
    await assert.rejects(
      inbox.write.batchProcessRequests([SOURCE_CHAIN_ID, [], flipped], { account: deployer }),
      /InvalidVerifierSignature/
    );
  });
});
