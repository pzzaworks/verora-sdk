/** Base class for every error thrown by the SDK */
export class VeroraError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The client is missing configuration required for the call (wallet, API URL, contract address) */
export class ConfigurationError extends VeroraError {}

/** An argument passed to the SDK is malformed or out of range; nothing was sent */
export class InvalidArgumentError extends VeroraError {}

/** A write was attempted without a wallet client or account */
export class WalletNotConnectedError extends VeroraError {
  constructor() {
    super('A wallet client with an account is required for this call');
  }
}

/** The Verora API returned a non-success status or an unreadable body */
export class ApiError extends VeroraError {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A transaction would revert, was mined but reverted, or an expected event was missing.
 * `errorName` and `errorArgs` hold the decoded Verora custom error when the revert could be decoded.
 */
export class TransactionError extends VeroraError {
  constructor(
    message: string,
    readonly errorName?: string,
    readonly errorArgs?: readonly unknown[],
  ) {
    super(message);
  }
}

/**
 * `failExpiredQuery` was called on a query with responses while the finalizer's grace period is still
 * running. Anyone can close the query once `opensAt` (unix seconds) has passed.
 */
export class FinalizationWindowOpenError extends TransactionError {
  constructor(
    readonly queryId: string,
    readonly opensAt: bigint,
  ) {
    super(`Query ${queryId} can only be expired by anyone after ${opensAt.toString()} (finalizer grace period)`, 'FinalizationWindowOpen', [queryId, opensAt]);
  }
}

/** Waiting for a query result exceeded the timeout */
export class QueryTimeoutError extends VeroraError {
  constructor(readonly queryId: string) {
    super(`Timed out waiting for query ${queryId}`);
  }
}

/** Encrypting or decrypting a payload failed */
export class EncryptionError extends VeroraError {}

/** An agent protocol request or response is malformed */
export class AgentProtocolError extends VeroraError {}

/** Why `verifyAgentQueryRequest` rejected a request */
export type AgentRequestRejection =
  | 'chain_mismatch'
  | 'query_consumer_mismatch'
  | 'query_not_found'
  | 'requester_mismatch'
  | 'query_type_mismatch'
  | 'query_data_mismatch'
  | 'deadline_mismatch'
  | 'agent_not_assigned'
  | 'query_not_open'
  | 'deadline_passed';

/**
 * An agent request does not match an open on-chain query assigned to the agent. Never sign it.
 * Extends `AgentProtocolError`, so handlers that answer protocol errors with 400 cover it too.
 */
export class AgentRequestRejectedError extends AgentProtocolError {
  constructor(
    readonly reason: AgentRequestRejection,
    message: string,
  ) {
    super(message);
  }
}
