import {
  BaseError,
  decodeErrorResult,
  encodeFunctionData,
  isHex,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from 'viem';
import { agentRegistryAbi, paymentRouterAbi, queryConsumerAbi, reputationManagerAbi, stakingPoolAbi } from './abis';
import { VeroraApi } from './api';
import { assertContracts, type VeroraContracts } from './deployment';
import { decryptResponse, encryptQuery, type EncryptionKeyPair } from './encryption';
import {
  ConfigurationError,
  EncryptionError,
  FinalizationWindowOpenError,
  InvalidArgumentError,
  QueryTimeoutError,
  TransactionError,
  WalletNotConnectedError,
} from './errors';

export const QueryStatus = { Pending: 0, InProgress: 1, Completed: 2, Failed: 3 } as const;
export type QueryStatus = (typeof QueryStatus)[keyof typeof QueryStatus];

export const AgentStatus = { Inactive: 0, Active: 1, Suspended: 2, Slashed: 3 } as const;
export type AgentStatus = (typeof AgentStatus)[keyof typeof AgentStatus];

export interface VeroraClientConfig {
  publicClient: PublicClient<Transport, Chain>;
  /** Required for writes (registration, queries, staking, withdrawals) */
  walletClient?: WalletClient<Transport, Chain, Account>;
  contracts: VeroraContracts;
  /** Verora API base URL, enables `client.api` */
  apiUrl?: string;
}

export interface RegisterAgentParams {
  endpoint: string;
  capabilities: string[];
  /** URI of the agent metadata JSON (see `api.uploadMetadata`) */
  metadataUri: string;
  attestation?: Hex;
}

export interface CreateQueryParams {
  queryType: string;
  queryData: Hex;
  agents: Hex[];
  /** Payment in wei, split between responding agents */
  payment: bigint;
  /**
   * Seconds until the deadline (default 10 minutes, max 30 days). Must be at least the contract's
   * `minQueryDuration` (5 minutes by default) plus `DEADLINE_INCLUSION_BUFFER_SECONDS`, so the deadline
   * still satisfies the minimum when the transaction lands a few blocks later.
   */
  ttlSeconds?: number;
}

export interface CreateEncryptedQueryParams {
  prompt: string;
  agentId: Hex;
  /** Agent's X25519 public key (from its metadata) */
  agentPublicKey: string;
  /** Requester key pair, e.g. from `deriveEncryptionKeyPair` */
  keyPair: EncryptionKeyPair;
  payment: bigint;
  /** Same rules as `CreateQueryParams.ttlSeconds` */
  ttlSeconds?: number;
}

export interface PendingQueriesPage {
  /** Index of the first entry to return (default 0) */
  offset?: number;
  /** Maximum entries to return (default 100) */
  limit?: number;
}

/** One decrypted response of an encrypted query; a response that fails to decrypt does not hide the others */
export type EncryptedResponseResult =
  | { agentId: Hex; ok: true; text: string }
  | { agentId: Hex; ok: false; error: EncryptionError };

export interface WaitForQueryOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
}

const DEFAULT_TTL_SECONDS = 600;
const DEFAULT_PENDING_PAGE_SIZE = 100;

/** Longest allowed query lifetime (`QueryConsumer.MAX_QUERY_DURATION`) */
export const MAX_QUERY_DURATION_SECONDS = 30 * 24 * 60 * 60;

/** Headroom added on top of `minQueryDuration` for the blocks between reading the clock and inclusion */
export const DEADLINE_INCLUSION_BUFFER_SECONDS = 60;

/** Time after the deadline reserved for the finalizer (`QueryConsumer.FINALIZATION_GRACE_PERIOD`) */
export const FINALIZATION_GRACE_PERIOD_SECONDS = 60 * 60;

/**
 * Headroom on top of every gas estimate. A write that creates storage costs more when another
 * transaction cleared the same slots between the estimate and inclusion (a fresh slot is ~100k gas on
 * Sepolia), so sending the exact estimate can run out of gas. Unused gas is not charged.
 */
const GAS_BUFFER_PERCENT = 25n;

function withGasBuffer(gas: bigint): bigint {
  return gas + (gas * GAS_BUFFER_PERCENT) / 100n;
}

/**
 * Typed client for the Verora contracts plus (optionally) the Verora API.
 *
 * Queries and payments happen on-chain through QueryConsumer; the Verora oracle delivers them to
 * agents and finalizes them. Every write waits for the receipt and throws if it reverted.
 */
export class VeroraClient {
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly contracts: VeroraContracts;
  private readonly walletClient?: WalletClient<Transport, Chain, Account>;
  private readonly apiClient?: VeroraApi;

  constructor(config: VeroraClientConfig) {
    this.publicClient = config.publicClient;
    this.walletClient = config.walletClient;
    this.contracts = assertContracts(config.contracts);
    this.apiClient = config.apiUrl ? new VeroraApi(config.apiUrl) : undefined;
  }

  /** REST API client; requires `apiUrl` */
  get api(): VeroraApi {
    if (!this.apiClient) throw new ConfigurationError('Pass apiUrl to use the Verora API');
    return this.apiClient;
  }

  /*//////////////////////////////////////////////////////////////
                                AGENTS
  //////////////////////////////////////////////////////////////*/

  async registerAgent(params: RegisterAgentParams): Promise<{ agentId: Hex; receipt: TransactionReceipt }> {
    const receipt = await this.write(this.contracts.agentRegistry, encodeFunctionData({ abi: agentRegistryAbi, functionName: 'registerAgent', args: [params.endpoint, params.capabilities, params.attestation ?? '0x', params.metadataUri] }));
    const [event] = parseEventLogs({ abi: agentRegistryAbi, logs: receipt.logs, eventName: 'AgentRegistered' });
    if (!event) throw new TransactionError('AgentRegistered event not found in receipt');
    return { agentId: event.args.agentId, receipt };
  }

  updateAgent(agentId: Hex, endpoint: string, capabilities: string[], attestation: Hex = '0x'): Promise<TransactionReceipt> {
    return this.write(this.contracts.agentRegistry, encodeFunctionData({ abi: agentRegistryAbi, functionName: 'updateAgent', args: [agentId, endpoint, capabilities, attestation] }));
  }

  updateMetadataUri(agentId: Hex, metadataUri: string): Promise<TransactionReceipt> {
    return this.write(this.contracts.agentRegistry, encodeFunctionData({ abi: agentRegistryAbi, functionName: 'updateMetadataURI', args: [agentId, metadataUri] }));
  }

  suspendAgent(agentId: Hex, reason: string): Promise<TransactionReceipt> {
    return this.write(this.contracts.agentRegistry, encodeFunctionData({ abi: agentRegistryAbi, functionName: 'suspendAgent', args: [agentId, reason] }));
  }

  reactivateAgent(agentId: Hex): Promise<TransactionReceipt> {
    return this.write(this.contracts.agentRegistry, encodeFunctionData({ abi: agentRegistryAbi, functionName: 'reactivateAgent', args: [agentId] }));
  }

  async getAgent(agentId: Hex) {
    const registry = { address: this.contracts.agentRegistry, abi: agentRegistryAbi } as const;
    const [info, status, reputation] = await Promise.all([
      this.publicClient.readContract({ ...registry, functionName: 'getAgent', args: [agentId] }),
      this.publicClient.readContract({ ...registry, functionName: 'getAgentStatus', args: [agentId] }),
      this.publicClient.readContract({
        address: this.contracts.reputationManager,
        abi: reputationManagerAbi,
        functionName: 'getReputation',
        args: [agentId],
      }),
    ]);
    return { ...info, status: status as AgentStatus, reputation };
  }

  getAgentsByOwner(owner: Address): Promise<readonly Hex[]> {
    return this.publicClient.readContract({
      address: this.contracts.agentRegistry,
      abi: agentRegistryAbi,
      functionName: 'getAgentsByOwner',
      args: [owner],
    });
  }

  /*//////////////////////////////////////////////////////////////
                                QUERIES
  //////////////////////////////////////////////////////////////*/

  /** Shortest allowed time between query creation and its deadline, in seconds */
  getMinQueryDuration(): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.contracts.queryConsumer,
      abi: queryConsumerAbi,
      functionName: 'minQueryDuration',
    });
  }

  /**
   * Pays for a query on-chain. The deadline is `latest block timestamp + ttlSeconds`; throws
   * `InvalidArgumentError` before sending if `ttlSeconds` is outside the contract's bounds.
   */
  async createQuery(params: CreateQueryParams): Promise<{ queryId: Hex; receipt: TransactionReceipt }> {
    const ttlSeconds = params.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > MAX_QUERY_DURATION_SECONDS) {
      throw new InvalidArgumentError(`ttlSeconds must be a whole number of seconds up to ${MAX_QUERY_DURATION_SECONDS}`);
    }
    const [block, minQueryDuration] = await Promise.all([this.publicClient.getBlock(), this.getMinQueryDuration()]);
    const minimum = minQueryDuration + BigInt(DEADLINE_INCLUSION_BUFFER_SECONDS);
    if (BigInt(ttlSeconds) < minimum) {
      throw new InvalidArgumentError(`ttlSeconds must be at least ${minimum.toString()} (minQueryDuration ${minQueryDuration.toString()}s plus ${DEADLINE_INCLUSION_BUFFER_SECONDS}s inclusion buffer)`);
    }
    const deadline = block.timestamp + BigInt(ttlSeconds);

    const receipt = await this.write(this.contracts.queryConsumer, encodeFunctionData({ abi: queryConsumerAbi, functionName: 'createQuery', args: [params.queryType, params.queryData, deadline, params.agents] }), params.payment);
    const [event] = parseEventLogs({ abi: queryConsumerAbi, logs: receipt.logs, eventName: 'QueryCreated' });
    if (!event) throw new TransactionError('QueryCreated event not found in receipt');
    return { queryId: event.args.queryId, receipt };
  }

  /** Creates an end-to-end encrypted query; only the agent can read the prompt and only you the answer */
  createEncryptedQuery(params: CreateEncryptedQueryParams): Promise<{ queryId: Hex; receipt: TransactionReceipt }> {
    return this.createQuery({
      queryType: 'encrypted',
      queryData: encryptQuery(params.prompt, params.agentPublicKey, params.keyPair.publicKey),
      agents: [params.agentId],
      payment: params.payment,
      ttlSeconds: params.ttlSeconds,
    });
  }

  getQuery(queryId: Hex) {
    return this.publicClient.readContract({
      address: this.contracts.queryConsumer,
      abi: queryConsumerAbi,
      functionName: 'getQuery',
      args: [queryId],
    });
  }

  getResponses(queryId: Hex) {
    return this.publicClient.readContract({
      address: this.contracts.queryConsumer,
      abi: queryConsumerAbi,
      functionName: 'getResponses',
      args: [queryId],
    });
  }

  getAggregatedResult(queryId: Hex): Promise<Hex> {
    return this.publicClient.readContract({
      address: this.contracts.queryConsumer,
      abi: queryConsumerAbi,
      functionName: 'getAggregatedResult',
      args: [queryId],
    });
  }

  /** Polls until the query is completed or failed */
  async waitForQuery(queryId: Hex, options: WaitForQueryOptions = {}) {
    const { timeoutMs = 5 * 60_000, pollIntervalMs = 3000 } = options;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const query = await this.getQuery(queryId);
      if (query.status === QueryStatus.Completed || query.status === QueryStatus.Failed) {
        const [responses, aggregatedResult] = await Promise.all([this.getResponses(queryId), this.getAggregatedResult(queryId)]);
        return { query, responses, aggregatedResult };
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    throw new QueryTimeoutError(queryId);
  }

  /**
   * Decrypts every response of an encrypted query with the requester key. Each entry reports its own
   * outcome, so one malformed or foreign response never hides the others.
   */
  async readEncryptedResponses(queryId: Hex, keyPair: EncryptionKeyPair): Promise<EncryptedResponseResult[]> {
    const responses = await this.getResponses(queryId);
    return responses.map((response): EncryptedResponseResult => {
      try {
        return { agentId: response.agentId, ok: true, text: decryptResponse(response.responseData, keyPair.secretKey) };
      } catch (error) {
        const failure = error instanceof EncryptionError ? error : new EncryptionError('Failed to decrypt response');
        return { agentId: response.agentId, ok: false, error: failure };
      }
    });
  }

  /** Query IDs still waiting on an agent, one page at a time (the list is unordered) */
  getPendingQueriesForAgent(agentId: Hex, page: PendingQueriesPage = {}): Promise<readonly Hex[]> {
    const { offset = 0, limit = DEFAULT_PENDING_PAGE_SIZE } = page;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit <= 0) {
      throw new InvalidArgumentError('offset must be >= 0 and limit > 0');
    }
    return this.publicClient.readContract({
      address: this.contracts.queryConsumer,
      abi: queryConsumerAbi,
      functionName: 'getPendingQueriesForAgent',
      args: [agentId, BigInt(offset), BigInt(limit)],
    });
  }

  /** Number of queries still waiting on an agent */
  getPendingQueryCount(agentId: Hex): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.contracts.queryConsumer,
      abi: queryConsumerAbi,
      functionName: 'getPendingQueryCount',
      args: [agentId],
    });
  }

  /** Requester only, while the query has no responses; refunds the payment */
  cancelQuery(queryId: Hex): Promise<TransactionReceipt> {
    return this.write(this.contracts.queryConsumer, encodeFunctionData({ abi: queryConsumerAbi, functionName: 'cancelQuery', args: [queryId] }));
  }

  /**
   * Closes an expired query (permissionless). Without responses it fails and refunds the requester as
   * soon as the deadline passes. With responses the finalizer keeps priority for
   * `FINALIZATION_GRACE_PERIOD_SECONDS` after the deadline; calling earlier throws
   * `FinalizationWindowOpenError` with the time it opens. After that it pays every responder.
   */
  async expireQuery(queryId: Hex): Promise<TransactionReceipt> {
    try {
      return await this.write(this.contracts.queryConsumer, encodeFunctionData({ abi: queryConsumerAbi, functionName: 'failExpiredQuery', args: [queryId] }));
    } catch (error) {
      if (error instanceof TransactionError && error.errorName === 'FinalizationWindowOpen') {
        const opensAt = error.errorArgs?.[1];
        if (typeof opensAt === 'bigint') throw new FinalizationWindowOpenError(queryId, opensAt);
      }
      throw error;
    }
  }

  /** Refund credited to `requester` because pushing it failed (claim it with `withdrawRefund`) */
  getPendingRefund(requester: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.contracts.queryConsumer,
      abi: queryConsumerAbi,
      functionName: 'getPendingRefund',
      args: [requester],
    });
  }

  /** Withdraws refunds that could not be pushed to the connected account */
  withdrawRefund(): Promise<TransactionReceipt> {
    return this.write(this.contracts.queryConsumer, encodeFunctionData({ abi: queryConsumerAbi, functionName: 'withdrawRefund' }));
  }

  /*//////////////////////////////////////////////////////////////
                                STAKING
  //////////////////////////////////////////////////////////////*/

  stake(agentId: Hex, amount: bigint): Promise<TransactionReceipt> {
    return this.write(this.contracts.stakingPool, encodeFunctionData({ abi: stakingPoolAbi, functionName: 'stake', args: [agentId] }), amount);
  }

  /** Starts unbonding `amount` wei of stake, or everything with `'all'` */
  unstake(agentId: Hex, amount: bigint | 'all'): Promise<TransactionReceipt> {
    return this.write(this.contracts.stakingPool, encodeFunctionData({ abi: stakingPoolAbi, functionName: 'unstake', args: [agentId, amount === 'all' ? 2n ** 256n - 1n : amount] }));
  }

  withdrawStake(agentId: Hex): Promise<TransactionReceipt> {
    return this.write(this.contracts.stakingPool, encodeFunctionData({ abi: stakingPoolAbi, functionName: 'withdraw', args: [agentId] }));
  }

  claimRewards(agentId: Hex): Promise<TransactionReceipt> {
    return this.write(this.contracts.stakingPool, encodeFunctionData({ abi: stakingPoolAbi, functionName: 'claimRewards', args: [agentId] }));
  }

  getStake(agentId: Hex, staker: Address) {
    return this.publicClient.readContract({
      address: this.contracts.stakingPool,
      abi: stakingPoolAbi,
      functionName: 'getStake',
      args: [agentId, staker],
    });
  }

  getTotalStake(agentId: Hex): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.contracts.stakingPool,
      abi: stakingPoolAbi,
      functionName: 'getTotalStake',
      args: [agentId],
    });
  }

  /*//////////////////////////////////////////////////////////////
                                PAYMENTS
  //////////////////////////////////////////////////////////////*/

  getPendingFees(account: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.contracts.paymentRouter,
      abi: paymentRouterAbi,
      functionName: 'getPendingFees',
      args: [account],
    });
  }

  /** Withdraws the connected agent owner's accrued fees */
  withdrawFees(): Promise<TransactionReceipt> {
    return this.write(this.contracts.paymentRouter, encodeFunctionData({ abi: paymentRouterAbi, functionName: 'withdrawFees' }));
  }

  /*//////////////////////////////////////////////////////////////
                                INTERNAL
  //////////////////////////////////////////////////////////////*/

  /** Simulates, sends, and waits for a write; throws on revert */
  private async write(to: Address, data: Hex, value?: bigint): Promise<TransactionReceipt> {
    if (!this.walletClient) throw new WalletNotConnectedError();
    const { account } = this.walletClient;
    let gas: bigint;
    try {
      await this.publicClient.call({ account, to, data, value });
      gas = await this.publicClient.estimateGas({ account, to, data, value });
    } catch (error) {
      const revert = decodeRevert(error);
      throw new TransactionError(`Transaction would revert: ${revert.reason}`, revert.errorName, revert.errorArgs);
    }
    const hash = await this.walletClient.sendTransaction({ account, to, data, value, gas: withGasBuffer(gas), chain: this.walletClient.chain });
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new TransactionError(`Transaction ${hash} reverted`);
    return receipt;
  }
}

export function createVeroraClient(config: VeroraClientConfig): VeroraClient {
  return new VeroraClient(config);
}

const knownAbis = [queryConsumerAbi, agentRegistryAbi, stakingPoolAbi, paymentRouterAbi, reputationManagerAbi];

/** Revert data carried by the deepest error in the chain (RPC errors put it in `data` or `data.data`) */
function revertData(error: BaseError): Hex | undefined {
  const source: unknown = error.walk((cause) => typeof cause === 'object' && cause !== null && 'data' in cause);
  if (typeof source !== 'object' || source === null || !('data' in source)) return undefined;
  const { data } = source;
  const value: unknown = typeof data === 'object' && data !== null && 'data' in data ? data.data : data;
  return typeof value === 'string' && isHex(value) && value.length > 2 ? value : undefined;
}

interface DecodedRevert {
  reason: string;
  errorName?: string;
  errorArgs?: readonly unknown[];
}

/** Turns a failed call into a readable reason, decoding Verora custom errors (name and args) when possible */
function decodeRevert(error: unknown): DecodedRevert {
  if (!(error instanceof BaseError)) return { reason: error instanceof Error ? error.message : String(error) };
  const data = revertData(error);
  if (data) {
    for (const abi of knownAbis) {
      try {
        const { errorName, args } = decodeErrorResult({ abi, data });
        return { reason: errorName, errorName, errorArgs: args };
      } catch {
        // Not an error of this contract; try the next ABI
      }
    }
  }
  return { reason: error.shortMessage };
}
