import { encodeFunctionData } from "viem";
import { network } from "hardhat";
import {
  asAddress,
  deployChainlinkPriceOracle,
  deployTestnetPriceOracle,
  getViemClients,
  optionalEnv,
  resolveDeployerAddress,
  waitMined,
} from "./deploy-utils.js";

const SET_PRICE_ORACLE_ABI = [
  {
    type: "function",
    name: "setPriceOracle",
    inputs: [{ name: "newOracle", type: "address" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
] as const;

/**
 * Migrate a live inbox (+ optional portal factory) to a new oracle without redeploying the inbox.
 *
 * Env:
 * - INBOX_ADDRESS (required)
 * - FACTORY_ADDRESS (optional)
 * - USE_PLAIN_ORACLE=1 for manual PriceOracle instead of ChainlinkPriceOracle
 */
const main = async () => {
  const inboxRaw = optionalEnv("INBOX_ADDRESS");
  if (!inboxRaw) {
    throw new Error("INBOX_ADDRESS is required for migrate-oracle");
  }
  const inboxAddress = asAddress(inboxRaw, "INBOX_ADDRESS");
  const usePlain = optionalEnv("USE_PLAIN_ORACLE") === "1";

  console.log("[migrate-oracle] Connecting…");
  const connection = await network.connect();
  const { viem, provider, networkName } = connection;
  const { chainId, publicClient, walletClient } = await getViemClients(viem, provider, networkName);
  const deployer = await resolveDeployerAddress(walletClient);
  const writeOpts = { account: deployer };

  console.log(`[migrate-oracle] chainId=${chainId} deploy new oracle (plain=${usePlain})…`);
  const deployParams = { viem, publicClient, walletClient, chainId };
  const oracle = usePlain
    ? await deployTestnetPriceOracle(deployParams)
    : await deployChainlinkPriceOracle(deployParams);

  const [localUsd, remoteUsd] = await oracle.read.getPricesUSD();
  console.log(`[migrate-oracle] New oracle ${oracle.address} local=${localUsd} remote=${remoteUsd}`);

  const inbox = await viem.getContractAt("Inbox", inboxAddress, {
    client: { public: publicClient, wallet: walletClient },
  });
  const hInbox = (await inbox.write.setPriceOracle([oracle.address], writeOpts)) as `0x${string}`;
  await waitMined(publicClient, hInbox);
  console.log(`[migrate-oracle] Inbox ${inboxAddress} → setPriceOracle(${oracle.address})`);

  const factoryRaw = optionalEnv("FACTORY_ADDRESS");
  if (factoryRaw) {
    const factoryAddress = asAddress(factoryRaw, "FACTORY_ADDRESS");
    const hFactory = await walletClient.sendTransaction({
      account: deployer,
      to: factoryAddress,
      data: encodeFunctionData({
        abi: SET_PRICE_ORACLE_ABI,
        functionName: "setPriceOracle",
        args: [oracle.address],
      }),
    });
    await waitMined(publicClient, hFactory);
    console.log(`[migrate-oracle] Factory ${factoryAddress} → setPriceOracle(${oracle.address})`);
  }

  console.log("[migrate-oracle] Done — keeper only needs oracle.refreshCache() going forward");
};

main().catch((error) => {
  console.error("[migrate-oracle] Failed:", error);
  process.exitCode = 1;
});
