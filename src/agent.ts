import {
  BaseError,
  ContractFunctionRevertedError,
  isAddress,
  isAddressEqual,
  isHex,
  keccak256,
  size,
  stringToBytes,
  type Address,
  type Hex,
  type LocalAccount,
  type PublicClient,
  type WalletClient,
} from 'viem';
import { queryConsumerAbi } from './abis';
import type { VeroraContracts } from './deployment';
import { AgentProtocolError, AgentRequestRejectedError, ConfigurationError, type AgentRequestRejection } from './errors';

/**
 * Agent-side helpers for Verora agent protocol v1.
 *
 * The Verora oracle POSTs an `AgentQueryRequest` (JSON) to your registered endpoint. Parse it with
 * `parseAgentQueryRequest`, check it against the chain with `verifyAgentQueryRequest`, then answer with
 * `{ responseData, signature }` where the signature is `signAgentResponse(...)` made with the agent
 * owner's key. The oracle verifies it and relays it on-chain, so your agent never pays gas.
 */
export const AGENT_PROTOCOL_VERSION = 1;

/** Contract limits (`QueryConsumer.MAX_*_LENGTH`), in bytes */
export const MAX_RESPONSE_BYTES = 16_384;
export const MAX_QUERY_DATA_BYTES = 16_384;
export const MAX_QUERY_TYPE_BYTES = 64;

export interface AgentQueryRequest {
  version: typeof AGENT_PROTOCOL_VERSION;
  chainId: number;
  queryConsumer: Address;
  queryId: Hex;
  agentId: Hex;
  requester: Address;
  queryType: string;
  queryData: Hex;
  /** Unix seconds; responses are accepted on-chain until this timestamp */
  deadline: number;
}

export interface AgentQueryResponse {
  responseData: Hex;
  signature: Hex;
}

/**
 * EIP-712 types of a relayed response. The signature binds the answer to the exact request stored
 * on-chain: `queryTypeHash = keccak256(queryType)`, `queryDataHash = keccak256(queryData)`,
 * `responseHash = keccak256(responseData)`.
 */
export const responseTypes = {
  Response: [
    { name: 'queryId', type: 'bytes32' },
    { name: 'agentId', type: 'bytes32' },
    { name: 'queryTypeHash', type: 'bytes32' },
    { name: 'queryDataHash', type: 'bytes32' },
    { name: 'responseHash', type: 'bytes32' },
  ],
} as const;

export function responseDomain(chainId: number, queryConsumer: Address) {
  return { name: 'Verora QueryConsumer', version: '1', chainId, verifyingContract: queryConsumer } as const;
}

/** The fields of a request that a response signature covers */
export type SignedRequestFields = Pick<AgentQueryRequest, 'chainId' | 'queryConsumer' | 'queryId' | 'agentId' | 'queryType' | 'queryData'>;

/** Builds the EIP-712 `Response` message for a request and response bytes */
export function responseMessage(request: SignedRequestFields, responseData: Hex) {
  return {
    queryId: request.queryId,
    agentId: request.agentId,
    queryTypeHash: keccak256(stringToBytes(request.queryType)),
    queryDataHash: keccak256(request.queryData),
    responseHash: keccak256(responseData),
  } as const;
}

const isBytes32 = (value: unknown): value is Hex => typeof value === 'string' && isHex(value, { strict: true }) && value.length === 66;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/**
 * Validates an incoming oracle request body and returns a clean copy of it. Rejects requests whose
 * deadline has already passed. This only checks the shape: always follow it with
 * `verifyAgentQueryRequest` before doing work or signing.
 */
export function parseAgentQueryRequest(body: unknown): AgentQueryRequest {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new AgentProtocolError('Request body must be a JSON object');
  const { version, chainId, queryConsumer, requester, queryId, agentId, queryType, queryData, deadline } = body as Record<string, unknown>;

  if (version !== AGENT_PROTOCOL_VERSION) throw new AgentProtocolError('Unsupported protocol version');
  if (typeof chainId !== 'number' || !Number.isSafeInteger(chainId) || chainId <= 0) throw new AgentProtocolError('Invalid chainId');
  if (typeof queryConsumer !== 'string' || !isAddress(queryConsumer)) throw new AgentProtocolError('Invalid queryConsumer');
  if (typeof requester !== 'string' || !isAddress(requester)) throw new AgentProtocolError('Invalid requester');
  if (!isBytes32(queryId) || !isBytes32(agentId)) throw new AgentProtocolError('Invalid queryId or agentId');
  if (typeof queryType !== 'string' || stringToBytes(queryType).length > MAX_QUERY_TYPE_BYTES) throw new AgentProtocolError('Invalid queryType');
  if (typeof queryData !== 'string' || !isHex(queryData, { strict: true }) || size(queryData) > MAX_QUERY_DATA_BYTES) {
    throw new AgentProtocolError('Invalid queryData');
  }
  if (typeof deadline !== 'number' || !Number.isSafeInteger(deadline) || deadline <= 0) throw new AgentProtocolError('Invalid deadline');
  if (deadline < nowSeconds()) throw new AgentProtocolError('Query deadline has passed');

  return { version, chainId, queryConsumer, requester, queryId, agentId, queryType, queryData, deadline };
}

/** QueryConsumer status values that still accept responses */
const OPEN_STATUSES: ReadonlySet<number> = new Set([0, 1]);

/**
 * Checks a parsed request against the `QueryConsumer` contract before you do any work or sign anything.
 *
 * Your endpoint is public, so anyone can POST a request to it. This confirms that the request targets
 * the chain and `QueryConsumer` you configured, that the query exists with the same requester, type,
 * data, and deadline, that it is still open, that its deadline has not passed, and that `agentId` is
 * assigned to it. Throws `AgentRequestRejectedError` (with a `reason`) on any mismatch and
 * `ConfigurationError` if the public client and `contracts` disagree on the chain. Returns the on-chain
 * query.
 *
 * `contracts` is usually the result of `parseDeployment`; when it carries a `chainId` that is enforced too.
 */
export async function verifyAgentQueryRequest(
  publicClient: PublicClient,
  contracts: Pick<VeroraContracts, 'queryConsumer'> & { chainId?: number },
  request: AgentQueryRequest,
) {
  const chainId = await publicClient.getChainId();
  if (publicClient.chain && publicClient.chain.id !== chainId) {
    throw new ConfigurationError(`Public client chain ${publicClient.chain.id} does not match RPC chain ${chainId}`);
  }
  if (contracts.chainId !== undefined && contracts.chainId !== chainId) {
    throw new ConfigurationError(`Deployment is for chain ${contracts.chainId} but the RPC serves chain ${chainId}`);
  }

  const reject = (reason: AgentRequestRejection, message: string) =>
    new AgentRequestRejectedError(reason, message);

  if (request.chainId !== chainId) throw reject('chain_mismatch', `Request is for chain ${request.chainId}, expected ${chainId}`);
  if (!isAddressEqual(request.queryConsumer, contracts.queryConsumer)) {
    throw reject('query_consumer_mismatch', 'Request targets a different QueryConsumer');
  }

  let query;
  try {
    query = await publicClient.readContract({
      address: contracts.queryConsumer,
      abi: queryConsumerAbi,
      functionName: 'getQuery',
      args: [request.queryId],
    });
  } catch (error) {
    const reverted = error instanceof BaseError ? error.walk((cause) => cause instanceof ContractFunctionRevertedError) : null;
    if (reverted instanceof ContractFunctionRevertedError && reverted.data?.errorName === 'QueryNotFound') {
      throw reject('query_not_found', `Query ${request.queryId} does not exist`);
    }
    throw error;
  }

  if (!isAddressEqual(query.requester, request.requester)) throw reject('requester_mismatch', 'Requester does not match the on-chain query');
  if (keccak256(stringToBytes(query.queryType)) !== keccak256(stringToBytes(request.queryType))) {
    throw reject('query_type_mismatch', 'queryType does not match the on-chain query');
  }
  if (keccak256(query.queryData) !== keccak256(request.queryData)) throw reject('query_data_mismatch', 'queryData does not match the on-chain query');
  if (query.deadline !== BigInt(request.deadline)) throw reject('deadline_mismatch', 'Deadline does not match the on-chain query');
  if (!query.assignedAgents.some((agentId) => agentId.toLowerCase() === request.agentId.toLowerCase())) {
    throw reject('agent_not_assigned', 'Agent is not assigned to this query');
  }
  if (!OPEN_STATUSES.has(query.status)) throw reject('query_not_open', 'Query is no longer open');
  if (query.deadline < BigInt(nowSeconds())) throw reject('deadline_passed', 'Query deadline has passed');

  return query;
}

export interface SignAgentResponseParams {
  /** The agent owner's account (local account or wallet client with an account) */
  signer: LocalAccount | WalletClient;
  request: SignedRequestFields;
  responseData: Hex;
}

/** Signs a response for relaying. `signer` must be the agent owner. Verify the request first. */
export async function signAgentResponse({ signer, request, responseData }: SignAgentResponseParams): Promise<AgentQueryResponse> {
  if (!isHex(responseData, { strict: true })) throw new AgentProtocolError('responseData must be hex');
  if (size(responseData) > MAX_RESPONSE_BYTES) throw new AgentProtocolError(`responseData exceeds ${MAX_RESPONSE_BYTES} bytes`);

  const typedData = {
    domain: responseDomain(request.chainId, request.queryConsumer),
    types: responseTypes,
    primaryType: 'Response' as const,
    message: responseMessage(request, responseData),
  };

  let signature: Hex;
  if (isLocalAccount(signer)) {
    signature = await signer.signTypedData(typedData);
  } else {
    if (!signer.account) throw new AgentProtocolError('Wallet client has no account');
    signature = await signer.signTypedData({ ...typedData, account: signer.account });
  }
  return { responseData, signature };
}

function isLocalAccount(signer: LocalAccount | WalletClient): signer is LocalAccount {
  return 'type' in signer && signer.type === 'local';
}
