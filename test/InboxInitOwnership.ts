import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { deployTestInbox, mpcAbiReEncodeOf, feeManagerOf } from "../scripts/deploy-test-inbox.js";
import { CREATEX_ADDRESS } from "../scripts/createx.js";

const PLACEHOLDER_OWNER = "0x0000000000000000000000000000000000000001";

describe("Inbox init ownership", { concurrency: false, timeout: 1_800_000 }, () => {
  it("constructor leaves placeholder owner until init; init transfers to admin", { timeout: 600_000 }, async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;

    const inbox = await deployTestInbox(viem, {
      client: { public: publicClient, wallet },
    });

    const before = (await inbox.read.owner()) as `0x${string}`;
    assert.equal(before.toLowerCase(), PLACEHOLDER_OWNER);

    await inbox.write.init([deployer, 1000n, mpcAbiReEncodeOf(inbox), feeManagerOf(inbox)], { account: deployer });

    const after = (await inbox.read.owner()) as `0x${string}`;
    assert.equal(after.toLowerCase(), deployer.toLowerCase());
    assert.notEqual(after.toLowerCase(), PLACEHOLDER_OWNER);

    await assert.rejects(
      () =>
        inbox.write.init([deployer, 1000n, mpcAbiReEncodeOf(inbox), feeManagerOf(inbox)], { account: deployer }),
      /AlreadyInitialized/
    );
  });

  it("rejects init from a non-deployer account", { timeout: 600_000 }, async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet, otherWallet] = await viem.getWalletClients();
    const other = otherWallet.account.address as `0x${string}`;

    const inbox = await deployTestInbox(viem, {
      client: { public: publicClient, wallet },
    });

    await assert.rejects(
      () =>
        inbox.write.init([other, 1000n, mpcAbiReEncodeOf(inbox), feeManagerOf(inbox)], {
          account: other,
        }),
      /reverted/
    );
  });

  it("allows CreateX to init (CREATE3 constructor sender is the proxy, not CreateX)", { timeout: 600_000 }, async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;

    const inbox = await deployTestInbox(viem, {
      client: { public: publicClient, wallet },
    });

    await publicClient.request({
      method: "hardhat_impersonateAccount",
      params: [CREATEX_ADDRESS],
    });
    await publicClient.request({
      method: "hardhat_setBalance",
      params: [CREATEX_ADDRESS, "0x1000000000000000000"],
    });
    const createxWallet = await viem.getWalletClient(CREATEX_ADDRESS);
    const asCreateX = await viem.getContractAt("Inbox", inbox.address, {
      client: { public: publicClient, wallet: createxWallet },
    });

    await asCreateX.write.init([deployer, 1000n, mpcAbiReEncodeOf(inbox), feeManagerOf(inbox)], {
      account: CREATEX_ADDRESS,
    });
    const after = (await inbox.read.owner()) as `0x${string}`;
    assert.equal(after.toLowerCase(), deployer.toLowerCase());
  });

  it("rejects init when feeManager has no code", { timeout: 600_000 }, async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const publicClient = await viem.getPublicClient();
    const [wallet, otherWallet] = await viem.getWalletClients();
    const deployer = wallet.account.address as `0x${string}`;
    const empty = otherWallet.account.address as `0x${string}`;

    const inbox = await deployTestInbox(viem, {
      client: { public: publicClient, wallet },
    });

    await assert.rejects(
      () => inbox.write.init([deployer, 1000n, mpcAbiReEncodeOf(inbox), empty], { account: deployer }),
      /ModuleHasNoCode/
    );
  });
});
