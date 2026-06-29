import fs from "node:fs/promises";
import path from "node:path";
import { network } from "hardhat";
import {
  appendDeploymentLog,
  asAddress,
  deployTestnetPriceOracle,
  getViemClients,
  optionalEnv,
  readDeployConfig,
  resolveDeployerAddress,
  TESTNET_COTI_USD,
  TESTNET_ETH_USD,
} from "./deploy-utils.js";

const deployConfigPath = path.resolve(process.cwd(), "deployConfig.json");

/**
 * Deploy `PriceOracle` with testnet ETH/COTI USD spot prices.
 *
 * Local vs remote (matches `oracleUsdPricesForChain`):
 * - Sepolia (11155111) / Hardhat (31337): local = ETH, remote = COTI
 * - COTI testnet (`COTI_TESTNET_CHAIN_ID`, default 7082400): local = COTI, remote = ETH
 *
 * Optional: set `INBOX_ADDRESS` to call `Inbox.setPriceOracle(oracle)` after deploy.
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
  console.log(`[deploy-oracle] Connected: chainId=${chainId} network=${networkLabel}`);
  console.log(
    `[deploy-oracle] Spot prices (USD per whole token): ETH=${TESTNET_ETH_USD} COTI=${TESTNET_COTI_USD}`
  );

  console.log("[deploy-oracle] Deploying PriceOracle and setting 18-decimal USD prices…");
  const oracle = await deployTestnetPriceOracle({
    viem,
    publicClient,
    walletClient,
    chainId,
  });
  const [localUsd, remoteUsd] = await oracle.read.getPricesUSD();
  console.log(`[deploy-oracle] PriceOracle deployed: ${oracle.address}`);
  console.log(`[deploy-oracle] getPricesUSD() local=${localUsd} remote=${remoteUsd} (18-dec fixed)`);

  const inboxRaw = optionalEnv("INBOX_ADDRESS");
  if (inboxRaw) {
    const inboxAddress = asAddress(inboxRaw, "INBOX_ADDRESS");
    console.log(`[deploy-oracle] Wiring inbox ${inboxAddress} → setPriceOracle…`);
    const deployer = await resolveDeployerAddress(walletClient);
    const inbox = await viem.getContractAt("Inbox", inboxAddress, {
      client: { public: publicClient, wallet: walletClient },
    });
    await inbox.write.setPriceOracle([oracle.address], { account: deployer });
    console.log("[deploy-oracle] Inbox.setPriceOracle done");
  } else {
    console.log("[deploy-oracle] INBOX_ADDRESS unset — skip Inbox.setPriceOracle (export it to wire an inbox)");
  }

  console.log("[deploy-oracle] Writing deployment log entry");
  await appendDeploymentLog({
    contract: "PriceOracle",
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
