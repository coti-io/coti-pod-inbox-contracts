import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { network } from "hardhat";
import { oracleTokensForChain } from "../scripts/oracle-tokens.js";
import { usdPerWholeToken18 } from "../scripts/deploy-utils.js";

const ETH_8 = 2103_41000000n;

describe("Chainlink future updatedAt", { concurrency: false, timeout: 600_000 }, () => {
  it("rejects future-dated updatedAt even when maxStaleness is 0", { timeout: 300_000 }, async () => {
    const { viem, provider } = await network.connect({ network: "hardhat" });
    const client = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const owner = wallet.account.address as `0x${string}`;
    const c = { public: client, wallet };
    const { localToken } = oracleTokensForChain(31337);

    const feed = await viem.deployContract("MockChainlinkAggregator", [8, ETH_8], { client: c });
    // maxStaleness 0: no max-age bound, but future updatedAt must still fail.
    const oracle = await viem.deployContract("ChainlinkLiveOracle", [owner, 0n], { client: c });
    await oracle.write.setFeed([localToken, feed.address], { account: owner });

    assert.equal(await oracle.read.getLivePrice([localToken]), usdPerWholeToken18("2103.41"));

    const now = BigInt((await client.getBlock()).timestamp);
    await feed.write.setUpdatedAt([now + 10_000n], { account: owner });
    assert.equal(await oracle.read.getLivePrice([localToken]), 0n);

    // Past updatedAt with maxStaleness 0 still succeeds (age unbound).
    await feed.write.setUpdatedAt([now - 1n], { account: owner });
    // Mine so block.timestamp > updatedAt if needed
    await provider.request({ method: "evm_mine", params: [] });
    assert.ok((await oracle.read.getLivePrice([localToken])) > 0n);
  });

  it("setMaxStaleness(0) reverts", { timeout: 300_000 }, async () => {
    const { viem } = await network.connect({ network: "hardhat" });
    const client = await viem.getPublicClient();
    const [wallet] = await viem.getWalletClients();
    const owner = wallet.account.address as `0x${string}`;
    const oracle = await viem.deployContract("ChainlinkLiveOracle", [owner, 3600n], {
      client: { public: client, wallet },
    });
    await assert.rejects(() => oracle.write.setMaxStaleness([0n], { account: owner }), /ZeroMaxStaleness/);
  });
});
