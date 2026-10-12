import { isAddress, isHex, type Address, type Hex, type WalletClient } from 'viem';
import { createSiweMessage } from 'viem/siwe';
import { ApiError, ConfigurationError, InvalidArgumentError, WalletNotConnectedError } from './errors';

export interface Paginated<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
}

export interface AgentMetadata {
  name?: string;
  description?: string;
  image?: string;
  banner?: string;
  publicKey?: string;
  website?: string;
}

export interface ApiAgent {
  id: Hex;
  owner: Address;
  endpoint: string;
  capabilities: string[];
  metadataUri: string;
  metadata: AgentMetadata | null;
  status: 'active' | 'suspended' | 'slashed' | 'inactive';
  adminSuspended: boolean;
  registeredAt: string;
  /** 0 - 10000 basis points */
  reputation: number;
  totalQueries: number;
  successfulQueries: number;
  failedQueries: number;
  /** wei */
  totalStake: string;
  stakerCount: number;
  healthStatus: 'unknown' | 'healthy' | 'unhealthy';
  healthCheckedAt: string | null;
}

export interface ApiQuery {
  id: Hex;
  requester: Address;
  queryType: string;
  queryData: Hex;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  cancelled: boolean;
  payment: string;
  deadline: string;
  assignedAgents: Hex[];
  aggregatedResult: Hex | null;
  createdAt: string;
  finalizedAt: string | null;
  txHash: Hex;
}

export interface ApiQueryDetail extends ApiQuery {
  responses: Array<{ agentId: Hex; responseData: Hex; submittedAt: string; txHash: Hex }>;
  dispatches: Array<{ agentId: Hex; status: 'pending' | 'relayed' | 'failed'; attempts: number; lastError: string | null }>;
}

export interface NetworkStats {
  totalQueries: number;
  completedQueries: number;
  failedQueries: number;
  openQueries: number;
  totalVolume: string;
  activeAgents: number;
  totalAgents: number;
}

export interface StakingStats {
  totalStaked: string;
  stakingPositions: number;
  rewardsDistributed30d: string;
  apy: number;
}

export interface AgentStakingStats {
  agentId: Hex;
  totalStaked: string;
  stakerCount: number;
  rewardsDistributed30d: string;
  apy: number;
}

export interface StakePositionView {
  agentId: Hex;
  amount: string;
  shares: string;
  pendingRewards: string;
  unbondingAmount: string;
  withdrawableAmount: string;
  nextUnlockTime: number;
}

export interface ListAgentsParams {
  page?: number;
  limit?: number;
  status?: 'active' | 'suspended' | 'slashed';
  owner?: Address;
  capability?: string;
  search?: string;
  sort?: 'reputation' | 'stake' | 'newest';
}

export interface ListQueriesParams {
  page?: number;
  limit?: number;
  requester?: Address;
  agentId?: Hex;
  status?: ApiQuery['status'];
}

export interface MetadataInput {
  name: string;
  description: string;
  publicKey?: string;
  website?: string;
  /** base64 data URL (PNG, JPEG, GIF, or WebP; max 256KB) */
  icon?: string;
  /** base64 data URL (PNG, JPEG, GIF, or WebP; max 512KB) */
  banner?: string;
}

export interface SignInOptions {
  /** host[:port] of the app the user signs in to; must be in the API's SIWE_DOMAINS */
  domain: string;
  /** origin URI of the app, e.g. https://veroraprotocol.com */
  uri: string;
  chainId: number;
  statement?: string;
}

type QueryValue = string | number | undefined;

/** Client for the Verora REST API (indexer reads, SIWE sessions, metadata hosting) */
export class VeroraApi {
  private readonly baseUrl: string;
  private sessionToken: string | null = null;

  constructor(
    baseUrl: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
  ) {
    if (!baseUrl) throw new ConfigurationError('apiUrl is required');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  get isSignedIn(): boolean {
    return this.sessionToken !== null;
  }

  /** Uses a session token obtained elsewhere (e.g. restored from storage) */
  setSessionToken(token: string | null): void {
    this.sessionToken = token;
  }

  /** Signs in with Ethereum (EIP-4361) and stores the session token for authenticated calls */
  async signIn(walletClient: WalletClient, options: SignInOptions): Promise<{ token: string; address: Address; expiresIn: number }> {
    const account = walletClient.account;
    if (!account) throw new WalletNotConnectedError();

    const { nonce } = await this.request<{ nonce: string }>('GET', '/auth/nonce');
    const message = createSiweMessage({
      address: account.address,
      chainId: options.chainId,
      domain: options.domain,
      nonce,
      uri: options.uri,
      version: '1',
      issuedAt: new Date(),
      statement: options.statement ?? 'Sign in to Verora',
    });
    const signature = await walletClient.signMessage({ account, message });
    const session = await this.request<{ token: string; address: Address; expiresIn: number }>('POST', '/auth/verify', {
      message,
      signature,
    });
    this.sessionToken = session.token;
    return session;
  }

  /** Hosts agent metadata and returns the URI to pass to `registerAgent` (requires sign-in) */
  uploadMetadata(input: MetadataInput): Promise<{ id: string; uri: string }> {
    return this.request('POST', '/metadata', input, true);
  }

  listAgents(params: ListAgentsParams = {}): Promise<Paginated<ApiAgent>> {
    return this.request('GET', `/agents${toQueryString({ ...params })}`);
  }

  getAgent(agentId: Hex): Promise<ApiAgent> {
    return this.request('GET', `/agents/${bytes32Path(agentId, 'agentId')}`);
  }

  listQueries(params: ListQueriesParams = {}): Promise<Paginated<ApiQuery>> {
    return this.request('GET', `/queries${toQueryString({ ...params })}`);
  }

  getQuery(queryId: Hex): Promise<ApiQueryDetail> {
    return this.request('GET', `/queries/${bytes32Path(queryId, 'queryId')}`);
  }

  getNetworkStats(): Promise<NetworkStats> {
    return this.request('GET', '/queries/stats');
  }

  getStakingStats(): Promise<StakingStats> {
    return this.request('GET', '/staking/stats');
  }

  getAgentStakingStats(agentId: Hex): Promise<AgentStakingStats> {
    return this.request('GET', `/staking/agents/${bytes32Path(agentId, 'agentId')}`);
  }

  getStakePositions(address: Address): Promise<StakePositionView[]> {
    return this.request('GET', `/staking/positions/${addressPath(address)}`);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, authenticated = false): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (authenticated) {
      if (!this.sessionToken) throw new ConfigurationError('Sign in before calling authenticated endpoints');
      headers.authorization = `Bearer ${this.sessionToken}`;
    }

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const payload = parseBody(await response.text());

    if (!response.ok) throw new ApiError(response.status, errorMessage(payload) ?? (response.statusText || `HTTP ${response.status}`));
    if (payload === INVALID_JSON) throw new ApiError(response.status, 'API returned a non-JSON response');
    return payload as T;
  }
}

const INVALID_JSON = Symbol('invalid-json');

/** Parses a response body; proxies and gateways can answer with HTML or plain text, so never assume JSON */
function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return INVALID_JSON;
  }
}

/** Extracts the API's `message` field (a string or a list of validation messages) from an error body */
function errorMessage(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null || !('message' in payload)) return undefined;
  const { message } = payload;
  if (typeof message === 'string' && message) return message;
  if (Array.isArray(message) && message.every((item) => typeof item === 'string')) return message.join('; ');
  return undefined;
}

/** Validates IDs and addresses before they are placed in a URL path */
function bytes32Path(value: string, name: string): string {
  if (typeof value !== 'string' || !isHex(value, { strict: true }) || value.length !== 66) throw new InvalidArgumentError(`${name} must be a 32-byte hex string`);
  return value.toLowerCase();
}

function addressPath(value: string): string {
  if (typeof value !== 'string' || !isAddress(value, { strict: false })) throw new InvalidArgumentError('address must be a valid Ethereum address');
  return value.toLowerCase();
}

function toQueryString(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : '';
}
