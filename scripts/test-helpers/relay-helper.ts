import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { hardhat } from "viem/chains";
import { RelayNode } from "../relay-node.js";
import { INBOX_ABI } from "./inbox-abi.js";

const DEFAULT_MINED_TARGET_EXECUTION_GAS = 2_500_000n;
const MIN_BATCH_TX_GAS_HEADROOM = 4_000_000n;

const minBatchTxGasForInnerStipend = (targetFee: bigint): bigint =>
  targetFee === 0n ? 0n : (targetFee * 64n + 62n) / 63n + MIN_BATCH_TX_GAS_HEADROOM;

const batchGasForMinedRequests = (mined: Array<{ targetFee?: bigint }>): bigint => {
  const required = mined.reduce((sum, request) => {
    const targetFee = request.targetFee && request.targetFee > 0n ? request.targetFee : DEFAULT_MINED_TARGET_EXECUTION_GAS;
    return sum + minBatchTxGasForInnerStipend(targetFee);
  }, 0n);
  return required > 0n ? required : DEFAULT_MINED_TARGET_EXECUTION_GAS + MIN_BATCH_TX_GAS_HEADROOM;
};

const requestNonce = (requestId: `0x${string}`): bigint => BigInt(requestId) & ((1n << 128n) - 1n);

export class RelayHelper {
  private chain1Client: ReturnType<typeof createPublicClient>;
  private chain2Client: ReturnType<typeof createPublicClient>;
  private chain2Wallet: ReturnType<typeof createWalletClient>;
  private account: ReturnType<typeof privateKeyToAccount>;
  private inbox1Address: `0x${string}`;
  private inbox2Address: `0x${string}`;
  private chain1Url: string;
  private chain1Id: number;
  private chain2Url: string;
  private chain2Id: number;
  private privateKey: `0x${string}`;

  constructor(
    chain1Url: string,
    chain1Id: number,
    chain2Url: string,
    chain2Id: number,
    inbox1Address: `0x${string}`,
    inbox2Address: `0x${string}`,
    privateKey: `0x${string}`
  ) {
    this.chain1Url = chain1Url;
    this.chain1Id = chain1Id;
    this.chain2Url = chain2Url;
    this.chain2Id = chain2Id;
    this.privateKey = privateKey;
    const account = privateKeyToAccount(privateKey);
    this.account = account;
    const nodeChainId = chain2Id;

    this.chain1Client = createPublicClient({
      chain: { ...hardhat, id: chain1Id },
      transport: http(chain1Url),
    });

    this.chain2Client = createPublicClient({
      chain: { ...hardhat, id: nodeChainId },
      transport: http(chain2Url),
    });

    this.chain2Wallet = createWalletClient({
      account,
      chain: { ...hardhat, id: nodeChainId },
      transport: http(chain2Url),
    });

    this.inbox1Address = inbox1Address;
    this.inbox2Address = inbox2Address;
  }

  async getMessagesFromChain1(from: number = 0, len: number = 0): Promise<any[]> {
    const totalRequests = await this.chain1Client.readContract({
      address: this.inbox1Address,
      abi: INBOX_ABI,
      functionName: "getRequestsLen",
      args: [BigInt(this.chain2Id)],
    });

    const total = Number(totalRequests);
    if (total === 0 || from >= total) {
      return [];
    }

    const remaining = total - from;
    const take = len === 0 || len > remaining ? remaining : len;

    const requests = (await this.chain1Client.readContract({
      address: this.inbox1Address,
      abi: INBOX_ABI,
      functionName: "getRequests",
      args: [BigInt(this.chain2Id), BigInt(from), BigInt(take)],
    })) as any[];
    return requests.map((request) => ({
      requestId: this.getTupleField<`0x${string}`>(request, "requestId", 0),
      chainId: Number(this.getTupleField<bigint>(request, "targetChainId", 1) ?? 0n),
      targetContract: this.getTupleField<`0x${string}`>(request, "targetContract", 2),
      sender: this.getTupleField<`0x${string}`>(request, "originalSender", 5),
      methodCall: this.getTupleField(request, "methodCall", 3),
      callbackSelector: this.getTupleField<`0x${string}`>(request, "callbackSelector", 7),
      errorSelector: this.getTupleField<`0x${string}`>(request, "errorSelector", 8),
      isTwoWay: this.getTupleField<boolean>(request, "isTwoWay", 9),
      sourceRequestId: this.getTupleField<`0x${string}`>(request, "sourceRequestId", 11),
      executed: this.getTupleField<boolean>(request, "executed", 10),
      targetFee: this.getTupleField<bigint>(request, "targetFee", 12) ?? 0n,
      callerFee: this.getTupleField<bigint>(request, "callerFee", 13) ?? 0n,
    }));
  }

  async relayMessage(
    sourceChainId: number,
    reqId: number,
    sender: `0x${string}`,
    timestamp: number,
    messageHash: `0x${string}`
  ): Promise<`0x${string}`> {
    const message = await this.chain2Client.readContract({
      address: this.inbox2Address,
      abi: INBOX_ABI,
      functionName: "getMessage",
      args: [messageHash],
    });

    if (message.processed) {
      throw new Error("Message already processed");
    }

    const hash = await this.chain2Wallet.writeContract({
      address: this.inbox2Address,
      abi: INBOX_ABI,
      functionName: "receiveMessage",
      chain: { ...hardhat, id: this.chain2Id },
      account: this.account,
      args: [BigInt(sourceChainId), BigInt(reqId), sender, BigInt(timestamp), messageHash],
    } as any);

    await this.chain2Client.waitForTransactionReceipt({ hash });
    return hash;
  }

  async relayAllPendingMessages(from: number = 0, len: number = 0): Promise<number> {
    const messages = await this.getMessagesFromChain1(from, len);
    let relayed = 0;

    for (const msg of messages) {
      if (msg.requestId && msg.sender) {
        try {
          const gas = batchGasForMinedRequests([{ targetFee: msg.targetFee ?? 0n }]);
          await this.chain2Wallet.writeContract({
            address: this.inbox2Address,
            abi: INBOX_ABI,
            functionName: "batchProcessRequests",
            chain: { ...hardhat, id: this.chain2Id },
            account: this.account,
            args: [
              BigInt(this.chain1Id),
              [
                {
                  requestId: msg.requestId,
                  sourceContract: msg.sender as `0x${string}`,
                  targetContract: msg.targetContract ?? "0x0000000000000000000000000000000000000000",
                  methodCall: msg.methodCall ?? {
                    selector: "0x00000000" as `0x${string}`,
                    data: "0x" as `0x${string}`,
                    datatypes: [] as readonly `0x${string}`[],
                    datalens: [] as readonly `0x${string}`[],
                  },
                  callbackSelector: msg.callbackSelector ?? "0x00000000",
                  errorSelector: msg.errorSelector ?? "0x00000000",
                  isTwoWay: Boolean(msg.isTwoWay),
                  sourceRequestId:
                    msg.sourceRequestId ?? "0x0000000000000000000000000000000000000000000000000000000000000000",
                  targetFee: msg.targetFee ?? 0n,
                  callerFee: msg.callerFee ?? 0n,
                },
              ],
            ],
            gas,
          } as any);
          relayed++;
        } catch (error: any) {
          if (error.message !== "Message already processed") {
            throw error;
          }
        }
      }
    }

    return relayed;
  }

  createRelayNode(pollInterval: number = 2000): RelayNode {
    return new RelayNode({
      chain1Url: this.chain1Url,
      chain1Id: this.chain1Id,
      chain2Url: this.chain2Url,
      chain2Id: this.chain2Id,
      inbox1Address: this.inbox1Address,
      inbox2Address: this.inbox2Address,
      privateKey: this.privateKey,
      pollInterval,
    });
  }

  private getTupleField<T>(value: any, key: string, index: number): T | undefined {
    return (value?.[key] ?? value?.[index]) as T | undefined;
  }

  async mineFromAToB(from: number, len: number): Promise<number> {
    const totalRequests = await this.chain1Client.readContract({
      address: this.inbox1Address,
      abi: INBOX_ABI,
      functionName: "getRequestsLen",
      args: [BigInt(this.chain2Id)],
    });

    const total = Number(totalRequests);
    if (total === 0 || from >= total) {
      return 0;
    }

    const remaining = total - from;
    const take = len === 0 || len > remaining ? remaining : len;

    const requests = (await this.chain1Client.readContract({
      address: this.inbox1Address,
      abi: INBOX_ABI,
      functionName: "getRequests",
      args: [BigInt(this.chain2Id), BigInt(from), BigInt(take)],
    })) as any[];
    const latestMinedRequestId = (await this.chain2Client.readContract({
      address: this.inbox2Address,
      abi: INBOX_ABI,
      functionName: "lastIncomingRequestId",
      args: [BigInt(this.chain1Id)],
    })) as `0x${string}`;
    const latestMinedNonce =
      latestMinedRequestId !== "0x0000000000000000000000000000000000000000000000000000000000000000"
        ? requestNonce(latestMinedRequestId)
        : 0n;

    const mined: Array<{
      requestId: `0x${string}`;
      sourceContract: `0x${string}`;
      targetContract: `0x${string}`;
      methodCall: {
        selector: `0x${string}`;
        data: `0x${string}`;
        datatypes: readonly `0x${string}`[];
        datalens: readonly `0x${string}`[];
      };
      callbackSelector: `0x${string}`;
      errorSelector: `0x${string}`;
      isTwoWay: boolean;
      sourceRequestId: `0x${string}`;
      targetFee: bigint;
      callerFee: bigint;
    }> = [];

    for (const request of requests) {
      const requestId = this.getTupleField<`0x${string}`>(request, "requestId", 0);
      const targetChainId = this.getTupleField<bigint>(request, "targetChainId", 1);
      const targetContract = this.getTupleField<`0x${string}`>(request, "targetContract", 2);
      const methodCall = this.getTupleField<{
        selector: `0x${string}`;
        data: `0x${string}`;
        datatypes: readonly `0x${string}`[];
        datalens: readonly `0x${string}`[];
      }>(request, "methodCall", 3);
      const callbackSelector = this.getTupleField<`0x${string}`>(request, "callbackSelector", 7);
      const errorSelector = this.getTupleField<`0x${string}`>(request, "errorSelector", 8);
      const originalSender = this.getTupleField<`0x${string}`>(request, "originalSender", 5);
      const isTwoWay = this.getTupleField<boolean>(request, "isTwoWay", 9);
      const executed = this.getTupleField<boolean>(request, "executed", 10);
      const sourceRequestId = this.getTupleField<`0x${string}`>(request, "sourceRequestId", 11);
      const targetFee = this.getTupleField<bigint>(request, "targetFee", 12) ?? 0n;
      const callerFee = this.getTupleField<bigint>(request, "callerFee", 13) ?? 0n;

      if (!requestId || requestId === "0x0000000000000000000000000000000000000000000000000000000000000000") {
        continue;
      }

      if (requestNonce(requestId) <= latestMinedNonce) {
        continue;
      }

      if (targetChainId !== BigInt(this.chain2Id)) {
        continue;
      }

      if (executed) {
        continue;
      }

      let incomingRequestId: `0x${string}` | undefined;
      let incomingExecuted = false;
      try {
        const incoming = await this.chain2Client.readContract({
          address: this.inbox2Address,
          abi: INBOX_ABI,
          functionName: "incomingRequests",
          args: [requestId],
        });
        incomingRequestId = this.getTupleField<`0x${string}`>(incoming, "requestId", 0);
        incomingExecuted = this.getTupleField<boolean>(incoming, "executed", 10) ?? false;
      } catch {
        // Empty Request structs contain dynamic fields that some viem versions cannot decode.
        incomingRequestId = undefined;
      }

      if (incomingRequestId && incomingExecuted) {
        continue;
      }

      mined.push({
        requestId: requestId!,
        sourceContract: originalSender!,
        targetContract: targetContract!,
        methodCall: methodCall!,
        callbackSelector: callbackSelector ?? "0x00000000",
        errorSelector: errorSelector ?? "0x00000000",
        isTwoWay: Boolean(isTwoWay),
        sourceRequestId:
          sourceRequestId ?? "0x0000000000000000000000000000000000000000000000000000000000000000",
        targetFee,
        callerFee,
      });
    }

    if (mined.length === 0) {
      return 0;
    }

    for (const request of mined) {
      const gas = batchGasForMinedRequests([request]);

      const mineHash = await this.chain2Wallet.writeContract({
        address: this.inbox2Address,
        abi: INBOX_ABI,
        functionName: "batchProcessRequests",
        chain: { ...hardhat, id: this.chain2Id },
        account: this.account,
        args: [BigInt(this.chain1Id), [request]],
        gas,
      } as any);
      await this.chain2Client.waitForTransactionReceipt({ hash: mineHash });
    }

    return mined.length;
  }
}
