import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { encodeFunctionData, toHex } from "viem";
import { network } from "hardhat";
import { deployTestInbox, inboxInitArgs, inboxViewsOf } from "../scripts/deploy-test-inbox.js";

describe("InboxViews fallback module", { concurrency: false, timeout: 300_000 }, () => {
  it("serves getRequest via Inbox fallback DELEGATECALL; staticcall works", async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;

    const inbox = await deployTestInbox(viem, { client: { public: publicClient, wallet } });
    await inbox.write.init(inboxInitArgs(inbox, deployer, 1000n), { account: deployer });

    assert.equal((await inbox.read.inboxViews()).toLowerCase(), inboxViewsOf(inbox).toLowerCase());

    const missing = (await inbox.read.getRequest([toHex(0, { size: 32 })])) as { requestId: `0x${string}` };
    assert.equal(missing.requestId, toHex(0, { size: 32 }));

    // eth_call / staticcall path: encode getRequestsLen and call
    const data = encodeFunctionData({
      abi: inbox.abi,
      functionName: "getRequestsLen",
      args: [1001n],
    });
    const raw = await publicClient.call({ to: inbox.address, data });
    assert.ok(raw.data && raw.data !== "0x");

    await assert.rejects(
      () =>
        publicClient.call({
          to: inbox.address,
          data: "0xdeadbeef",
        }),
      /./
    );
  });

  it("isMiner reads MinerBase storage through DELEGATECALL", async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;

    const inbox = await deployTestInbox(viem, { client: { public: publicClient, wallet } });
    await inbox.write.init(inboxInitArgs(inbox, deployer, 1000n), { account: deployer });
    assert.equal(await inbox.read.isMiner([deployer]), false);
    await inbox.write.addMiner([deployer], { account: deployer });
    assert.equal(await inbox.read.isMiner([deployer]), true);
  });
});
