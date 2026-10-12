export {
  VeroraClient,
  createVeroraClient,
  QueryStatus,
  AgentStatus,
  MAX_QUERY_DURATION_SECONDS,
  DEADLINE_INCLUSION_BUFFER_SECONDS,
  FINALIZATION_GRACE_PERIOD_SECONDS,
} from './client';
export type {
  VeroraClientConfig,
  RegisterAgentParams,
  CreateQueryParams,
  CreateEncryptedQueryParams,
  WaitForQueryOptions,
  PendingQueriesPage,
  EncryptedResponseResult,
} from './client';

export { VeroraApi } from './api';
export type {
  Paginated,
  AgentMetadata,
  ApiAgent,
  ApiQuery,
  ApiQueryDetail,
  NetworkStats,
  StakingStats,
  AgentStakingStats,
  StakePositionView,
  ListAgentsParams,
  ListQueriesParams,
  MetadataInput,
  SignInOptions,
} from './api';

export { parseDeployment } from './deployment';
export type { VeroraContracts, DeploymentManifest } from './deployment';

export {
  ENCRYPTION_KEY_MESSAGE,
  deriveEncryptionKeyPair,
  generateEncryptionKeyPair,
  encryptQuery,
  decryptQuery,
  encryptResponse,
  decryptResponse,
  encodeText,
  decodeText,
  isValidPublicKey,
  toBase64,
  fromBase64,
} from './encryption';
export type { EncryptionKeyPair, EncryptedMessage, EncryptedQuery } from './encryption';

export {
  AGENT_PROTOCOL_VERSION,
  MAX_RESPONSE_BYTES,
  MAX_QUERY_DATA_BYTES,
  MAX_QUERY_TYPE_BYTES,
  parseAgentQueryRequest,
  verifyAgentQueryRequest,
  signAgentResponse,
  responseDomain,
  responseTypes,
  responseMessage,
} from './agent';
export type { AgentQueryRequest, AgentQueryResponse, SignAgentResponseParams, SignedRequestFields } from './agent';

export {
  VeroraError,
  ConfigurationError,
  InvalidArgumentError,
  WalletNotConnectedError,
  ApiError,
  TransactionError,
  FinalizationWindowOpenError,
  QueryTimeoutError,
  EncryptionError,
  AgentProtocolError,
  AgentRequestRejectedError,
} from './errors';
export type { AgentRequestRejection } from './errors';

export { agentRegistryAbi, queryConsumerAbi, stakingPoolAbi, paymentRouterAbi, reputationManagerAbi, treasuryAbi } from './abis';
