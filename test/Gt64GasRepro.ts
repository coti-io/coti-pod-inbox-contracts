/**
 * Repro: `MockInbox.call64WithGas` → `MpcExecutorGt64Repro.gt64` with `gasAllowed` 54490913290 (COTI testnet only).
 *
 * Requires: `COTI_TESTNET_RPC_URL`, `COTI_TESTNET_PRIVATE_KEY` or `PRIVATE_KEY`.
 * Run: `npm run test:gt64-repro`
 *
 * Uses `http` + `privateKeyToAccount` for signing (Hardhat’s `getWalletClient(addr)` hits HHE716 on HTTP RPC).
 * Optional: `MPC_COTI_CONTRACT_DEPLOY_GAS`, `GT64_OUTER_GAS` if estimateGas is wrong for your RPC.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { network } from "hardhat";
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  getAddress,
  http,
  parseAbiItem,
  parseEventLogs,
  toEventSelector,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { resolveCotiTestnetPrivateKey, normalizePrivateKey } from "./system/mpc-test-utils.js";

const cotiRpc = process.env.COTI_TESTNET_RPC_URL?.trim();
const canRunCoti = Boolean(cotiRpc);

const deployGasOpt = (() => {
  const raw = process.env.MPC_COTI_CONTRACT_DEPLOY_GAS?.trim();
  if (!raw) return {};
  return { gas: BigInt(raw) };
})();

/** Optional outer-tx gas for `call64WithGas` (default: let viem estimate). Do not set absurdly high — fee = gas × price and must stay under viem’s fee cap (~1 ETH). */
const outerGasOpt = (() => {
  const raw = process.env.GT64_OUTER_GAS?.trim();
  if (!raw) return {};
  return { gas: BigInt(raw) };
})();

// const GAS_ALLOWED = 54490913290n;
const GAS_ALLOWED = 54490n;

const respondTopic = toEventSelector(parseAbiItem("event Respond(bytes)"));
const errorTopic = toEventSelector(parseAbiItem("event Error(bytes)"));

function formatWriteError(err: unknown): string {
  if (err === null || err === undefined) return String(err);
  if (typeof err === "object" && err !== null && "shortMessage" in err) {
    const o = err as { shortMessage?: string; message?: string; details?: string };
    return [o.shortMessage, o.message, o.details].filter(Boolean).join(" | ");
  }
  return err instanceof Error ? err.message : String(err);
}

if (!canRunCoti) {
  test.skip(
    "Gt64GasRepro (COTI): set COTI_TESTNET_RPC_URL and a funded COTI testnet private key",
    () => {}
  );
} else {
  test(
    "Gt64GasRepro: deploy + call64WithGas + Error/Respond",
    { timeout: 300_000 },
    async () => {
      const { viem } = await network.connect({ network: "cotiTestnet" });
      const cotiChainId = Number.parseInt(process.env.COTI_TESTNET_CHAIN_ID ?? "7082400", 10);
      const cotiChain = defineChain({
        id: cotiChainId,
        name: "COTI Testnet",
        nativeCurrency: { name: "COTI", symbol: "COTI", decimals: 18 },
        rpcUrls: { default: { http: [cotiRpc!] } },
      });
      const cotiPk = normalizePrivateKey(await resolveCotiTestnetPrivateKey(cotiRpc!));
      const pkHex = cotiPk as `0x${string}`;
      const account = privateKeyToAccount(pkHex);
      const transport = http(cotiRpc!);
      const publicClient = createPublicClient({ chain: cotiChain, transport });
      const walletClient = createWalletClient({ account, chain: cotiChain, transport });
      const deployer = account.address;

      const deployOpts = {
        client: { public: publicClient, wallet: walletClient },
        ...deployGasOpt,
      };

      const mockInbox = await viem.deployContract("MockInbox", [], { ...deployOpts } as any);
      const executor = await viem.deployContract("MpcExecutorGt64Repro", [mockInbox.address], {
        ...deployOpts,
      } as any);

      const inboxAddr = getAddress(mockInbox.address);

      let hash: `0x${string}`;
      try {
        hash = await mockInbox.write.call64WithGas(
          [executor.address, 2n, 1n, deployer, GAS_ALLOWED],
          { account, ...outerGasOpt }
        );
      } catch (err) {
        throw new Error(`call64WithGas failed: ${formatWriteError(err)}`, { cause: err });
      }

      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      assert.equal(
        receipt.status,
        "success",
        `outer tx must succeed; status=${receipt.status} logCount=${receipt.logs.length}`
      );

      const parsed = parseEventLogs({
        abi: mockInbox.abi,
        logs: receipt.logs,
        strict: false,
      });
      const errorEvents = parsed.filter((ev) => ev.eventName === "Error");
      const respondEvents = parsed.filter((ev) => ev.eventName === "Respond");
      const inboxLogs = receipt.logs.filter((l) => getAddress(l.address) === inboxAddr);
      const hasRespondTopic = inboxLogs.some((l) => l.topics[0] === respondTopic);
      const hasErrorTopic = inboxLogs.some((l) => l.topics[0] === errorTopic);
      console.log("errorEvents", errorEvents);
      console.log("respondEvents", respondEvents);
      console.log("hasRespondTopic", hasRespondTopic);
      console.log("hasErrorTopic", hasErrorTopic);

      assert.ok(
        errorEvents.length > 0 ||
          respondEvents.length > 0 ||
          hasRespondTopic ||
          hasErrorTopic,
        `expected MockInbox Error and/or Respond; parsed=${parsed.length} inboxLogs=${inboxLogs.length}`
      );
    }
  );
}
