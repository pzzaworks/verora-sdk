import { getAddress, isAddress, type Address } from 'viem';
import { ConfigurationError } from './errors';

/** Addresses of the Verora contracts on one chain */
export interface VeroraContracts {
  agentRegistry: Address;
  queryConsumer: Address;
  stakingPool: Address;
  paymentRouter: Address;
  reputationManager: Address;
  treasury?: Address;
}

/** Shape of `verora-contracts/deployments/<chainId>.json`, written by the deploy script */
export interface DeploymentManifest extends VeroraContracts {
  chainId: number;
  startBlock: number;
  owner: Address;
  finalizer: Address;
  treasury: Address;
}

/**
 * Validates a deployment manifest (e.g. fetched from your deployment or bundled with your app) and
 * returns checksummed contract addresses. There are deliberately no built-in placeholder addresses:
 * always pass the manifest of the network you actually target.
 */
export function parseDeployment(manifest: unknown): DeploymentManifest {
  if (typeof manifest !== 'object' || manifest === null) throw new ConfigurationError('Deployment manifest must be an object');
  const source = new Map<string, unknown>(Object.entries(manifest));

  const address = (key: string): Address => {
    const value = source.get(key);
    if (typeof value !== 'string' || !isAddress(value)) throw new ConfigurationError(`Deployment manifest has no valid ${key}`);
    return getAddress(value);
  };
  const integer = (key: string): number => {
    const value = Number(source.get(key));
    if (!Number.isSafeInteger(value) || value < 0) throw new ConfigurationError(`Deployment manifest has no valid ${key}`);
    return value;
  };

  return {
    chainId: integer('chainId'),
    startBlock: integer('startBlock'),
    owner: address('owner'),
    finalizer: address('finalizer'),
    treasury: address('treasury'),
    agentRegistry: address('agentRegistry'),
    queryConsumer: address('queryConsumer'),
    stakingPool: address('stakingPool'),
    paymentRouter: address('paymentRouter'),
    reputationManager: address('reputationManager'),
  };
}

const REQUIRED_CONTRACTS = ['agentRegistry', 'queryConsumer', 'stakingPool', 'paymentRouter', 'reputationManager'];

export function assertContracts(contracts: VeroraContracts): VeroraContracts {
  const provided = new Map<string, unknown>(Object.entries(contracts));
  for (const key of REQUIRED_CONTRACTS) {
    const value = provided.get(key);
    if (typeof value !== 'string' || !isAddress(value)) throw new ConfigurationError(`Invalid ${key} address`);
  }
  return contracts;
}
