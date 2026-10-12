import {
  createPublicClient,
  createWalletClient,
  custom,
  encodeErrorResult,
  encodeFunctionResult,
  http,
  keccak256,
  stringToBytes,
  verifyTypedData,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry, sepolia } from 'viem/chains';
import { describe, expect, it } from 'vitest';
import { queryConsumerAbi } from '../abis';
import { parseAgentQueryRequest, responseDomain, responseTypes, signAgentResponse, verifyAgentQueryRequest } from '../agent';
import { AgentProtocolError, AgentRequestRejectedError, ConfigurationError } from '../errors';

// Public Anvil development key, used for signing tests only
const owner = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const request = {
  version: 1,
  chainId: sepolia.id,
  queryConsumer: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707',
  queryId: `0x${'11'.repeat(32)}`,
  agentId: `0x${'22'.repeat(32)}`,
  requester: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
  queryType: 'plaintext',
  queryData: '0x68656c6c6f',
  deadline: 4_000_000_000,
} as const;

async function verify(responseData: Hex, signature: Hex, signed: { queryType: string; queryData: Hex } = request) {
  return verifyTypedData({
    address: owner.address,
    domain: responseDomain(request.chainId, request.queryConsumer),
    types: responseTypes,
    primaryType: 'Response',
    message: {
      queryId: request.queryId,
      agentId: request.agentId,
      queryTypeHash: keccak256(stringToBytes(signed.queryType)),
      queryDataHash: keccak256(signed.queryData),
      responseHash: keccak256(responseData),
    },
    signature,
  });
}

describe('parseAgentQueryRequest', () => {
  it('accepts a valid oracle request and drops unknown fields', () => {
    const parsed = parseAgentQueryRequest({ ...request, extra: 'ignored' });
    expect(parsed).toEqual(request);
  });

  it.each([
    ['wrong version', { ...request, version: 2 }],
    ['bad queryId', { ...request, queryId: '0x1234' }],
    ['bad consumer', { ...request, queryConsumer: 'nope' }],
    ['non-hex data', { ...request, queryData: 'hello' }],
    ['oversized queryType', { ...request, queryType: 'x'.repeat(65) }],
    ['oversized queryData', { ...request, queryData: `0x${'00'.repeat(16_385)}` }],
    ['fractional deadline', { ...request, deadline: 1.5 }],
    ['unsafe deadline', { ...request, deadline: Number.MAX_SAFE_INTEGER + 1 }],
    ['expired deadline', { ...request, deadline: 1_000 }],
    ['array body', [request]],
  ])('rejects a request with %s', (_label, body) => {
    expect(() => parseAgentQueryRequest(body)).toThrow(AgentProtocolError);
  });
});

describe('signAgentResponse', () => {
  it('signs responses bound to the request with a local account', async () => {
    const { responseData, signature } = await signAgentResponse({ signer: owner, request, responseData: '0xabcd' });
    expect(await verify(responseData, signature)).toBe(true);
    expect(await verify('0xabce', signature)).toBe(false);
    expect(await verify(responseData, signature, { queryType: 'encrypted', queryData: request.queryData })).toBe(false);
    expect(await verify(responseData, signature, { queryType: request.queryType, queryData: '0x00' })).toBe(false);
  });

  it('signs responses with a wallet client', async () => {
    const walletClient = createWalletClient({ account: owner, chain: foundry, transport: http('http://127.0.0.1:1') });
    const { signature } = await signAgentResponse({ signer: walletClient, request, responseData: '0x01' });
    expect(await verify('0x01', signature)).toBe(true);
  });

  it('rejects oversized responses', async () => {
    await expect(signAgentResponse({ signer: owner, request, responseData: `0x${'00'.repeat(16_385)}` })).rejects.toThrow(AgentProtocolError);
  });
});

type OnChainQuery = {
  queryId: Hex;
  requester: Hex;
  queryType: string;
  queryData: Hex;
  status: number;
  createdAt: bigint;
  deadline: bigint;
  payment: bigint;
  assignedAgents: readonly Hex[];
};

const onChainQuery: OnChainQuery = {
  queryId: request.queryId,
  requester: request.requester,
  queryType: request.queryType,
  queryData: request.queryData,
  status: 0,
  createdAt: 3_999_999_000n,
  deadline: BigInt(request.deadline),
  payment: 1n,
  assignedAgents: [request.agentId],
};

/** A public client whose JSON-RPC answers come from a local handler, so the contract read is exercised end to end */
function chainWith(query: OnChainQuery | 'missing', rpcChainId = sepolia.id) {
  return createPublicClient({
    chain: sepolia,
    transport: custom({
      request: ({ method }: { method: string }) => {
        if (method === 'eth_chainId') return Promise.resolve(`0x${rpcChainId.toString(16)}`);
        if (method !== 'eth_call') return Promise.reject(new Error(`unexpected ${method}`));
        if (query === 'missing') {
          const data = encodeErrorResult({ abi: queryConsumerAbi, errorName: 'QueryNotFound', args: [request.queryId] });
          return Promise.reject(Object.assign(new Error('execution reverted'), { code: 3, data }));
        }
        return Promise.resolve(encodeFunctionResult({ abi: queryConsumerAbi, functionName: 'getQuery', result: query }));
      },
    }, { retryCount: 0 }),
  });
}

const contracts = { queryConsumer: request.queryConsumer, chainId: sepolia.id };

describe('verifyAgentQueryRequest', () => {
  it('accepts a request that matches an open on-chain query', async () => {
    const query = await verifyAgentQueryRequest(chainWith(onChainQuery), contracts, request);
    expect(query.queryId).toBe(request.queryId);
  });

  it.each([
    ['chain_mismatch', onChainQuery, { ...request, chainId: 1 }],
    ['query_consumer_mismatch', onChainQuery, { ...request, queryConsumer: '0x0000000000000000000000000000000000000001' }],
    ['query_not_found', 'missing', request],
    ['requester_mismatch', { ...onChainQuery, requester: owner.address }, request],
    ['query_type_mismatch', { ...onChainQuery, queryType: 'encrypted' }, request],
    ['query_data_mismatch', { ...onChainQuery, queryData: '0x00' }, request],
    ['deadline_mismatch', { ...onChainQuery, deadline: onChainQuery.deadline + 1n }, request],
    ['agent_not_assigned', { ...onChainQuery, assignedAgents: [`0x${'33'.repeat(32)}`] }, request],
    ['query_not_open', { ...onChainQuery, status: 2 }, request],
    ['deadline_passed', { ...onChainQuery, deadline: 1_000n }, { ...request, deadline: 1_000 }],
  ] as const)('rejects with %s', async (reason, query, body) => {
    const error: unknown = await verifyAgentQueryRequest(chainWith(query), contracts, body).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AgentRequestRejectedError);
    expect((error as AgentRequestRejectedError).reason).toBe(reason);
  });

  it('refuses to run against a different chain than configured', async () => {
    await expect(verifyAgentQueryRequest(chainWith(onChainQuery, 1), contracts, request)).rejects.toThrow(ConfigurationError);
    await expect(verifyAgentQueryRequest(chainWith(onChainQuery), { ...contracts, chainId: 1 }, request)).rejects.toThrow(ConfigurationError);
  });
});
