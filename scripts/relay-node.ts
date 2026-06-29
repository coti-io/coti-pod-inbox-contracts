import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";

const INBOX_ABI = [
  {
    type: "event",
    name: "MessageSent",
    inputs: [
      { name: "messageHash", type: "bytes32", indexed: true },
      { name: "chainId", type: "uint256", indexed: true },
      { name: "reqId", type: "uint256", indexed: true },
      { name: "sender", type: "address", indexed: false },
      { name: "timestamp", type: "uint256", indexed: false },
    ],
  },
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "sourceChainId", type: "uint256" },
      { name: "reqId", type: "uint256" },
      { name: "sender", type: "address" },
      { name: "timestamp", type: "uint256" },
      { name: "messageHash", type: "bytes32" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "getMessage",
    stateMutability: "view",
    inputs: [{ name: "messageHash", type: "bytes32" }],
    outputs: [
      {
        name: "",
        type: "tuple",
        components: [
          { name: "chainId", type: "uint256" },
          { name: "reqId", type: "uint256" },
          { name: "sender", type: "address" },
          { name: "timestamp", type: "uint256" },
          { name: "processed", type: "bool" },
        ],
      },
    ],
  },
] as const;

interface RelayConfig {
  chain1Url: string;
  chain1Id: number;
  chain2Url: string;
  chain2Id: number;
  inbox1Address: `0x${string}`;
  inbox2Address: `0x${string}`;
  privateKey: `0x${string}`;
  pollInterval?: number;
}

export class RelayNode {
  private chain1Client: ReturnType<typeof createPublicClient>;
  private chain2Client: ReturnType<typeof createPublicClient>;
  private chain2Wallet: ReturnType<typeof createWalletClient>;
  private config: Required<RelayConfig>;
  private isRunning: boolean = false;
  private lastProcessedBlock: bigint = 0n;

  constructor(config: RelayConfig) {
    this.config = { pollInterval: 2000, ...config };
    const account = privateKeyToAccount(config.privateKey);

    this.chain1Client = createPublicClient({
      chain: { ...hardhat, id: config.chain1Id },
      transport: http(config.chain1Url),
    });

    this.chain2Client = createPublicClient({
      chain: { ...hardhat, id: config.chain2Id },
      transport: http(config.chain2Url),
    });

    this.chain2Wallet = createWalletClient({
      account,
      chain: { ...hardhat, id: config.chain2Id },
      transport: http(config.chain2Url),
    });
  }

  async start() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.lastProcessedBlock = await this.chain1Client.getBlockNumber();
    this.poll();
  }

  stop() {
    this.isRunning = false;
  }

  private async poll() {
    while (this.isRunning) {
      try {
        await this.processNewMessages();
        await new Promise((resolve) => setTimeout(resolve, this.config.pollInterval));
      } catch (error) {
        console.error("Poll error:", error);
        await new Promise((resolve) => setTimeout(resolve, this.config.pollInterval));
      }
    }
  }

  private async processNewMessages() {
    const currentBlock = await this.chain1Client.getBlockNumber();
    if (currentBlock <= this.lastProcessedBlock) return;

    const logs = await this.chain1Client.getLogs({
      address: this.config.inbox1Address,
      event: {
        type: "event",
        name: "MessageSent",
        inputs: [
          { type: "bytes32", indexed: true, name: "messageHash" },
          { type: "uint256", indexed: true, name: "chainId" },
          { type: "uint256", indexed: true, name: "reqId" },
          { type: "address", indexed: false, name: "sender" },
          { type: "uint256", indexed: false, name: "timestamp" },
        ],
      },
      fromBlock: this.lastProcessedBlock + 1n,
      toBlock: currentBlock,
    });

    for (const log of logs) {
      if (log.args.messageHash && log.args.chainId && log.args.reqId && log.args.sender && log.args.timestamp) {
        await this.relayMessage(
          log.args.messageHash,
          Number(log.args.chainId),
          Number(log.args.reqId),
          log.args.sender,
          Number(log.args.timestamp)
        );
      }
    }

    this.lastProcessedBlock = currentBlock;
  }

  private async relayMessage(
    messageHash: `0x${string}`,
    sourceChainId: number,
    reqId: number,
    sender: `0x${string}`,
    timestamp: number
  ) {
    try {
      const message = await this.chain2Client.readContract({
        address: this.config.inbox2Address,
        abi: INBOX_ABI,
        functionName: "getMessage",
        args: [messageHash],
      });

      if (message.processed) return;

      const hash = await this.chain2Wallet.writeContract({
        address: this.config.inbox2Address,
        abi: INBOX_ABI,
        functionName: "receiveMessage",
        args: [BigInt(sourceChainId), BigInt(reqId), sender, BigInt(timestamp), messageHash],
      });

      await this.chain2Client.waitForTransactionReceipt({ hash });
    } catch (error) {
      console.error(`Relay error for ${messageHash}:`, error);
    }
  }
}

const isMainModule = import.meta.url === `file://${process.argv[1]}` || 
                     process.argv[1]?.includes("relay-node");

if (isMainModule) {
  const config: RelayConfig = {
    chain1Url: process.env.CHAIN1_URL || "http://127.0.0.1:8545",
    chain1Id: parseInt(process.env.CHAIN1_ID || "31337"),
    chain2Url: process.env.CHAIN2_URL || "http://127.0.0.1:8546",
    chain2Id: parseInt(process.env.CHAIN2_ID || "31338"),
    inbox1Address: (process.env.INBOX1_ADDRESS || "0x0000000000000000000000000000000000000000") as `0x${string}`,
    inbox2Address: (process.env.INBOX2_ADDRESS || "0x0000000000000000000000000000000000000000") as `0x${string}`,
    privateKey: (process.env.PRIVATE_KEY || "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80") as `0x${string}`,
    pollInterval: parseInt(process.env.POLL_INTERVAL || "2000"),
  };

  const relay = new RelayNode(config);
  relay.start();

  process.on("SIGINT", () => {
    relay.stop();
    process.exit(0);
  });
}
