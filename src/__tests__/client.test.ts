import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeErrorResult,
  encodeFunctionResult,
  decodeFunctionData,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { describe, expect, it } from 'vitest';
import { queryConsumerAbi } from '../abis';
import { VeroraClient } from '../client';
import { encodeText, encryptResponse, generateEncryptionKeyPair } from '../encryption';
import { EncryptionError, FinalizationWindowOpenError, InvalidArgumentError } from '../errors';

// Public Anvil development key; nothing is ever sent to a real network in these tests
const account = privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a');
const contracts = {
  agentRegistry: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  queryConsumer: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707',
  stakingPool: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  paymentRouter: '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9',
  reputationManager: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
} as const;
const queryId: Hex = `0x${'aa'.repeat(32)}`;
const agentId: Hex = `0x${'bb'.repeat(32)}`;

type CallHandler = (data: Hex) => Hex | { revert: Hex };

/** Client over a local JSON-RPC handler: eth_call data is answered by `onCall` */
function clientWith(onCall: CallHandler) {
  const transport = custom(
    {
      request: ({ method, params }: { method: string; params?: unknown }) => {
        if (method === 'eth_chainId') return Promise.resolve(`0x${sepolia.id.toString(16)}`);
        if (method === 'eth_getBlockByNumber') {
          return Promise.resolve({ number: '0x10', timestamp: '0x64', hash: `0x${'00'.repeat(32)}`, transactions: [] });
        }
        if (method === 'eth_call') {
          const [call] = params as [{ data: Hex }];
          const result = onCall(call.data);
          if (typeof result === 'string') return Promise.resolve(result);
          return Promise.reject(Object.assign(new Error('execution reverted'), { code: 3, data: result.revert }));
        }
        return Promise.reject(new Error(`unexpected ${method}`));
      },
    },
    { retryCount: 0 },
  );
  return new VeroraClient({
    publicClient: createPublicClient({ chain: sepolia, transport }),
    walletClient: createWalletClient({ account, chain: sepolia, transport }),
    contracts,
  });
}

const fnName = (data: Hex) => decodeFunctionData({ abi: queryConsumerAbi, data }).functionName;

describe('VeroraClient queries', () => {
  it('rejects ttlSeconds below minQueryDuration plus the inclusion buffer before sending', async () => {
    const client = clientWith((data) => {
      if (fnName(data) === 'minQueryDuration') return encodeFunctionResult({ abi: queryConsumerAbi, functionName: 'minQueryDuration', result: 300n });
      throw new Error('no other call expected');
    });
    await expect(client.createQuery({ queryType: 'plaintext', queryData: '0x', agents: [agentId], payment: 1n, ttlSeconds: 300 })).rejects.toThrow(
      InvalidArgumentError,
    );
    await expect(client.createQuery({ queryType: 'plaintext', queryData: '0x', agents: [agentId], payment: 1n, ttlSeconds: 31 * 86_400 })).rejects.toThrow(
      InvalidArgumentError,
    );
  });

  it('turns FinalizationWindowOpen into a typed error with the opening time', async () => {
    const client = clientWith(() => ({
      revert: encodeErrorResult({ abi: queryConsumerAbi, errorName: 'FinalizationWindowOpen', args: [queryId, 1_700_003_600n] }),
    }));
    const error: unknown = await client.expireQuery(queryId).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(FinalizationWindowOpenError);
    expect((error as FinalizationWindowOpenError).opensAt).toBe(1_700_003_600n);
  });

  it('reads pending queries one page at a time', async () => {
    let args: readonly unknown[] | undefined;
    const client = clientWith((data) => {
      args = decodeFunctionData({ abi: queryConsumerAbi, data }).args;
      return encodeFunctionResult({ abi: queryConsumerAbi, functionName: 'getPendingQueriesForAgent', result: [queryId] });
    });
    await expect(client.getPendingQueriesForAgent(agentId, { offset: 20, limit: 10 })).resolves.toEqual([queryId]);
    expect(args).toEqual([agentId, 20n, 10n]);
    expect(() => client.getPendingQueriesForAgent(agentId, { limit: 0 })).toThrow(InvalidArgumentError);
  });

  it('reports each encrypted response on its own', async () => {
    const keyPair = generateEncryptionKeyPair();
    const responses = [
      { agentId, responseData: encryptResponse('42', keyPair.publicKey), submittedAt: 1n, validated: true },
      { agentId: queryId, responseData: encodeText('not encrypted'), submittedAt: 2n, validated: false },
    ];
    const client = clientWith(() => encodeFunctionResult({ abi: queryConsumerAbi, functionName: 'getResponses', result: responses }));

    const [good, bad] = await client.readEncryptedResponses(queryId, keyPair);
    expect(good).toEqual({ agentId, ok: true, text: '42' });
    expect(bad?.ok).toBe(false);
    if (bad && !bad.ok) expect(bad.error).toBeInstanceOf(EncryptionError);
  });
});
