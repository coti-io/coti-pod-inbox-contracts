import fs from "node:fs/promises";
import path from "node:path";
import { encodeFunctionData } from "viem";
import { network } from "hardhat";
import {
  appendDeploymentLog,
  asAddress,
  chainlinkFeedsForChain,
  deployChainlinkPriceOracle,
  deployTestnetPriceOracle,
  getViemClients,
  optionalEnv,
  readDeployConfig,
  resolveDeployerAddress,
  TESTNET_COTI_USD,
  TESTNET_ETH_USD,
  waitMined,
} from "./deploy-utils.js";

const deployConfigPath = path.resolve(process.cwd(), "deployConfig.json");

/**
 * Deploy `PoDPriceOracle` + `ChainlinkLiveOracle` (default) or plain `PriceOracle` when `USE_PLAIN_ORACLE=1`.
 *
 * Chainlink: local native leg from Data Feed; COTI leg manual (no Chainlink feed).
 * Optional: `INBOX_ADDRESS` → `Inbox.setPriceOracle(oracle)`; `FACTORY_ADDRESS` → portal factory sync.
 */
const main = async () => {
  console.log("[deploy-oracle] Connecting to network from CLI");
  const connection = await network.connect();
  const { viem, provider, networkName } = connection;
  const { chainId, chainName, publicClient, walletClient } = await getViemClients(
    viem,
    provider,
    networkName
  );
  const networkLabel = chainName ?? "unknown";
  const usePlain = optionalEnv("USE_PLAIN_ORACLE") === "1";
  console.log(`[deploy-oracle] Connected: chainId=${chainId} network=${networkLabel}`);
  console.log(
    `[deploy-oracle] Spot prices (USD per whole token): ETH=${TESTNET_ETH_USD} COTI=${TESTNET_COTI_USD}`
  );

  const deployParams = { viem, publicClient, walletClient, chainId };

  let oracle: { address: `0x${string}`; read: { getPricesUSD: () => Promise<readonly [bigint, bigint]> } };
  let contractName: string;

  if (usePlain) {
    console.log("[deploy-oracle] USE_PLAIN_ORACLE=1 — deploying manual PriceOracle…");
    oracle = await deployTestnetPriceOracle(deployParams);
    contractName = "PriceOracle";
  } else {
    const feeds = chainlinkFeedsForChain(chainId);
    console.log(
      `[deploy-oracle] Deploying PoDPriceOracle + ChainlinkLiveOracle localFeed=${feeds.localFeed} remoteFeed=${feeds.remoteFeed} manualLeg=${feeds.manualLeg}…`
    );
    oracle = await deployChainlinkPriceOracle(deployParams);
    contractName = "PoDPriceOracle";
  }

  const [localUsd, remoteUsd] = await oracle.read.getPricesUSD();
  console.log(`[deploy-oracle] ${contractName} deployed: ${oracle.address}`);
  console.log(`[deploy-oracle] getPricesUSD() local=${localUsd} remote=${remoteUsd} (18-dec fixed)`);

  const deployer = await resolveDeployerAddress(walletClient);

  const inboxRaw = optionalEnv("INBOX_ADDRESS");
  if (inboxRaw) {
    const inboxAddress = asAddress(inboxRaw, "INBOX_ADDRESS");
    console.log(`[deploy-oracle] Wiring inbox ${inboxAddress} → setPriceOracle…`);
    const inbox = await viem.getContractAt("Inbox", inboxAddress, {
      client: { public: publicClient, wallet: walletClient },
    });
    const hInbox = (await inbox.write.setPriceOracle([oracle.address], { account: deployer })) as `0x${string}`;
    await waitMined(publicClient, hInbox);
    console.log("[deploy-oracle] Inbox.setPriceOracle done");
  } else {
    console.log("[deploy-oracle] INBOX_ADDRESS unset — skip Inbox.setPriceOracle");
  }

  const factoryRaw = optionalEnv("FACTORY_ADDRESS");
  if (factoryRaw) {
    const factoryAddress = asAddress(factoryRaw, "FACTORY_ADDRESS");
    console.log(`[deploy-oracle] Wiring factory ${factoryAddress} → setPriceOracle…`);
    const hFactory = await walletClient.sendTransaction({
      account: deployer,
      to: factoryAddress,
      data: encodeFunctionData({
        abi: [
          {
            type: "function",
            name: "setPriceOracle",
            inputs: [{ type: "address" }],
            outputs: [],
            stateMutability: "nonpayable",
          },
        ] as const,
        functionName: "setPriceOracle",
        args: [oracle.address],
      }),
    });
    await waitMined(publicClient, hFactory);
    console.log("[deploy-oracle] Factory.setPriceOracle done");
  } else {
    console.log("[deploy-oracle] FACTORY_ADDRESS unset — skip factory wiring");
  }

  console.log("[deploy-oracle] Writing deployment log entry");
  await appendDeploymentLog({
    contract: contractName,
    address: oracle.address,
    chainId,
    network: networkLabel,
  });

  const deployConfig = await readDeployConfig();
  deployConfig.chains ??= {};
  const chainKey = String(chainId);
  deployConfig.chains[chainKey] ??= {};
  deployConfig.chains[chainKey].priceOracle = oracle.address;
  await fs.writeFile(deployConfigPath, `${JSON.stringify(deployConfig, null, 2)}\n`, "utf8");
  console.log("[deploy-oracle] Updated deployConfig.json");

  console.log("[deploy-oracle] Done");
};

main().catch((error) => {
  console.error("[deploy-oracle] Failed:", error);
  process.exitCode = 1;
});
