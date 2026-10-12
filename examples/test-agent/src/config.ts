/**
 * Environment configuration for the test agents. Everything is read once at startup and validated, so a
 * misconfigured deployment fails fast instead of answering with the wrong keys or on the wrong chain.
 */
import { readFileSync } from 'node:fs';
import nacl from 'tweetnacl';
import { fromBase64, generateEncryptionKeyPair, parseDeployment, toBase64 } from '@verora/sdk';
import { getAddress, isAddress, isHex, type Address, type Chain, type Hex } from 'viem';
import { mnemonicToAccount, privateKeyToAccount, type PrivateKeyAccount } from 'viem/accounts';
import { foundry, sepolia } from 'viem/chains';

/** One test agent identity: requests for it arrive at `/<slug>/query` */
export interface TestAgent {
  slug: string;
  /** The on-chain agent owner; every response is signed with this key */
  owner: PrivateKeyAccount;
  /** X25519 key pair for end-to-end encrypted queries (base64 public key, raw secret key) */
  encryption: { publicKey: string; secretKey: Uint8Array };
  /** True when no key was configured and a random one was generated for this process (development only) */
  ephemeralEncryptionKey: boolean;
}

export interface Config {
  production: boolean;
  port: number;
  chain: Chain;
  rpcUrl: string;
  queryConsumer: Address;
  agentRegistry: Address;
  agents: TestAgent[];
  /** Number of reverse proxy hops to trust for the client IP (Express `trust proxy`) */
  trustProxyHops: number;
  rateLimit: { burst: number; perMinute: number };
  ownerCacheTtlMs: number;
}

export class ConfigError extends Error {}

const CHAINS: ReadonlyMap<string, { chain: Chain; local: boolean }> = new Map([
  ['sepolia', { chain: sepolia, local: false }],
  ['foundry', { chain: foundry, local: true }],
  ['anvil', { chain: foundry, local: true }],
]);

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The public Anvil/Hardhat development mnemonic: its accounts must never sign on a real network */
const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';

function optional(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
}

function required(env: NodeJS.ProcessEnv, name: string, hint: string): string {
  const value = optional(env, name);
  if (!value) throw new ConfigError(`${name} must be set (${hint})`);
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number, { allowZero = false } = {}): number {
  const raw = optional(env, name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0 || (!allowZero && value === 0)) {
    throw new ConfigError(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} integer`);
  }
  return value;
}

function address(env: NodeJS.ProcessEnv, name: string): Address {
  const value = required(env, name, 'or set DEPLOYMENT to a deployment manifest path');
  if (!isAddress(value)) throw new ConfigError(`${name} is not a valid address`);
  return getAddress(value);
}

/** `alpha-1` -> `AGENT_ALPHA_1_OWNER_KEY` / `AGENT_ALPHA_1_ENCRYPTION_SECRET_KEY` */
export function agentEnvPrefix(slug: string): string {
  return `AGENT_${slug.toUpperCase().replaceAll('-', '_')}`;
}

function loadContracts(env: NodeJS.ProcessEnv, chain: Chain): { queryConsumer: Address; agentRegistry: Address } {
  const manifestPath = optional(env, 'DEPLOYMENT');
  if (manifestPath === undefined) {
    return { queryConsumer: address(env, 'QUERY_CONSUMER_ADDRESS'), agentRegistry: address(env, 'AGENT_REGISTRY_ADDRESS') };
  }
  if (optional(env, 'QUERY_CONSUMER_ADDRESS') || optional(env, 'AGENT_REGISTRY_ADDRESS')) {
    throw new ConfigError('Set either DEPLOYMENT or QUERY_CONSUMER_ADDRESS/AGENT_REGISTRY_ADDRESS, not both');
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    throw new ConfigError(`DEPLOYMENT manifest at ${manifestPath} could not be read as JSON`);
  }
  const deployment = parseDeployment(manifest);
  if (deployment.chainId !== chain.id) {
    throw new ConfigError(`DEPLOYMENT manifest is for chain ${deployment.chainId} but CHAIN is ${chain.id}`);
  }
  return { queryConsumer: deployment.queryConsumer, agentRegistry: deployment.agentRegistry };
}

function loadEncryptionKey(env: NodeJS.ProcessEnv, name: string, production: boolean): Pick<TestAgent, 'encryption' | 'ephemeralEncryptionKey'> {
  const raw = optional(env, name);
  if (raw === undefined) {
    if (production) throw new ConfigError(`${name} must be set in production (base64 of 32 random bytes)`);
    return { encryption: generateEncryptionKeyPair(), ephemeralEncryptionKey: true };
  }
  let secretKey: Uint8Array;
  try {
    secretKey = fromBase64(raw);
  } catch {
    throw new ConfigError(`${name} is not valid base64`);
  }
  if (secretKey.length !== nacl.box.secretKeyLength) {
    throw new ConfigError(`${name} must decode to ${nacl.box.secretKeyLength} bytes`);
  }
  const keyPair = nacl.box.keyPair.fromSecretKey(secretKey);
  return { encryption: { publicKey: toBase64(keyPair.publicKey), secretKey: keyPair.secretKey }, ephemeralEncryptionKey: false };
}

function loadAgents(env: NodeJS.ProcessEnv, local: boolean, production: boolean): TestAgent[] {
  const slugs = required(env, 'TEST_AGENTS', 'comma-separated agent slugs, e.g. alpha,beta')
    .split(',')
    .map((slug) => slug.trim())
    .filter(Boolean);
  if (slugs.length === 0) throw new ConfigError('TEST_AGENTS must list at least one agent slug');

  const anvilAddresses = local
    ? new Set<string>()
    : new Set(Array.from({ length: 20 }, (_, index) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index }).address.toLowerCase()));

  const agents: TestAgent[] = [];
  const seenOwners = new Set<string>();
  for (const slug of slugs) {
    if (!SLUG_PATTERN.test(slug)) throw new ConfigError(`Agent slug "${slug}" must match ${SLUG_PATTERN}`);
    if (agents.some((agent) => agent.slug === slug)) throw new ConfigError(`Agent slug "${slug}" is listed twice`);

    const prefix = agentEnvPrefix(slug);
    const ownerKey = required(env, `${prefix}_OWNER_KEY`, `the private key of the owner of agent "${slug}"`);
    if (!isHex(ownerKey, { strict: true }) || ownerKey.length !== 66) {
      throw new ConfigError(`${prefix}_OWNER_KEY must be a 0x-prefixed 32-byte hex private key`);
    }
    const owner = privateKeyToAccount(ownerKey as Hex);
    const ownerId = owner.address.toLowerCase();
    if (seenOwners.has(ownerId)) throw new ConfigError(`Agent "${slug}" reuses another agent's owner key`);
    if (anvilAddresses.has(ownerId)) {
      throw new ConfigError(`${prefix}_OWNER_KEY is a public Anvil development key and must not be used outside a local chain`);
    }
    seenOwners.add(ownerId);

    agents.push({ slug, owner, ...loadEncryptionKey(env, `${prefix}_ENCRYPTION_SECRET_KEY`, production) });
  }
  return agents;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';

  const chainName = required(env, 'CHAIN', 'sepolia, foundry, or anvil').toLowerCase();
  const chainEntry = CHAINS.get(chainName);
  if (!chainEntry) throw new ConfigError(`CHAIN must be one of ${[...CHAINS.keys()].join(', ')}`);
  const { chain, local } = chainEntry;

  const rpcUrl = local ? (optional(env, 'RPC_URL') ?? 'http://localhost:8545') : required(env, 'RPC_URL', 'JSON-RPC endpoint of the chain');
  if (!/^https?:\/\//.test(rpcUrl)) throw new ConfigError('RPC_URL must be an http(s) URL');

  const port = positiveInteger(env, 'PORT', 4102);
  if (port > 65_535) throw new ConfigError('PORT must be a valid TCP port');

  return {
    production,
    port,
    chain,
    rpcUrl,
    ...loadContracts(env, chain),
    agents: loadAgents(env, local, production),
    trustProxyHops: positiveInteger(env, 'TRUST_PROXY', 0, { allowZero: true }),
    rateLimit: {
      burst: positiveInteger(env, 'RATE_LIMIT_BURST', 30),
      perMinute: positiveInteger(env, 'RATE_LIMIT_PER_MINUTE', 60),
    },
    ownerCacheTtlMs: positiveInteger(env, 'OWNER_CACHE_TTL_SECONDS', 300) * 1000,
  };
}
