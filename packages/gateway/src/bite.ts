import {
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BITE } from "@skalenetwork/bite";
import type { GatewayConfig } from "./config.js";
import { logger } from "./utils/logger.js";

export interface BiteService {
  encryptIntent(intentId: string, data: Uint8Array): Promise<string>;
  triggerReveal(intentId: string): Promise<void>;
  getDecryptedIntent(intentId: string): Promise<Uint8Array | null>;
}

const biteIntentStoreAbi = [
  {
    name: "storeIntent",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [
      { name: "intentId", type: "bytes32" },
      { name: "encryptedBlob", type: "bytes" },
    ],
    outputs: [],
  },
  {
    name: "markPaid",
    type: "function",
    stateMutability: "nonpayable",
    inputs: [{ name: "intentId", type: "bytes32" }],
    outputs: [],
  },
  {
    name: "getIntent",
    type: "function",
    stateMutability: "view",
    inputs: [{ name: "intentId", type: "bytes32" }],
    outputs: [
      { name: "owner", type: "address" },
      { name: "paid", type: "bool" },
      { name: "revealed", type: "bool" },
      { name: "data", type: "bytes" },
    ],
  },
] as const;

export function createBiteService(config: GatewayConfig): BiteService | null {
  if (
    !config.skaleRpcUrl ||
    !config.skaleBiteContract ||
    !config.skalePrivateKey
  ) {
    logger.info("SKALE BITE not configured, encryption disabled");
    return null;
  }

  const rpcUrl = config.skaleRpcUrl;
  const contractAddress = config.skaleBiteContract as Address;
  const account = privateKeyToAccount(config.skalePrivateKey as Hex);

  const chain = config.skaleChainId
    ? {
        id: config.skaleChainId,
        name: "SKALE",
        nativeCurrency: { name: "sFUEL", symbol: "sFUEL", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      }
    : undefined;

  const transport = http(rpcUrl);

  const walletClient = createWalletClient({
    account,
    chain,
    transport,
  });

  const publicClient = createPublicClient({
    chain,
    transport,
  });

  const bite = new BITE(rpcUrl);

  logger.info("SKALE BITE service initialized", {
    rpcUrl,
    contract: contractAddress,
  });

  return {
    async encryptIntent(
      intentId: string,
      data: Uint8Array,
    ): Promise<string> {
      logger.debug("Encrypting intent", { intentId, size: data.length });

      const calldata = encodeFunctionData({
        abi: biteIntentStoreAbi,
        functionName: "storeIntent",
        args: [intentId as Hex, `0x${Buffer.from(data).toString("hex")}` as Hex],
      });

      const encryptedTx = await bite.encryptTransaction({
        to: contractAddress,
        data: calldata,
      });

      const txHash = await walletClient.sendTransaction({
        to: encryptedTx.to as Address,
        data: encryptedTx.data as Hex,
        gas: encryptedTx.gasLimit ? BigInt(encryptedTx.gasLimit) : 300000n,
      });

      logger.debug("Encrypted intent stored", { intentId, txHash });
      return txHash;
    },

    async triggerReveal(intentId: string): Promise<void> {
      logger.debug("Triggering BITE reveal", { intentId });

      const txHash = await walletClient.writeContract({
        address: contractAddress,
        abi: biteIntentStoreAbi,
        functionName: "markPaid",
        args: [intentId as Hex],
      });

      logger.debug("markPaid tx sent", { intentId, txHash });
    },

    async getDecryptedIntent(
      intentId: string,
    ): Promise<Uint8Array | null> {
      logger.debug("Getting decrypted intent", { intentId });

      const [_owner, _paid, revealed, data] = await publicClient.readContract({
        address: contractAddress,
        abi: biteIntentStoreAbi,
        functionName: "getIntent",
        args: [intentId as Hex],
      });

      if (!revealed) {
        logger.debug("Intent not yet revealed", { intentId });
        return null;
      }

      return new Uint8Array(Buffer.from((data as string).slice(2), "hex"));
    },
  };
}
