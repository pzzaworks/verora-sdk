/**
 * Verora test agents: one process serving several deterministic agents over agent protocol v1.
 *
 * Each configured agent (see TEST_AGENTS) answers at `POST /<slug>/query` and publishes its encryption
 * key at `GET /<slug>/encryption/public-key`. Every request is shape-checked with
 * `parseAgentQueryRequest`, pinned to the configured chain and QueryConsumer, verified against the
 * on-chain query with `verifyAgentQueryRequest`, and only then answered with a canned test answer
 * signed by the agent owner. Answers are test data only; there is no AI behind them.
 */
import express, { type NextFunction, type Request, type Response } from 'express';
import {
  AgentProtocolError,
  EncryptionError,
  decodeText,
  decryptQuery,
  encodeText,
  encryptResponse,
  parseAgentQueryRequest,
  signAgentResponse,
  verifyAgentQueryRequest,
  agentRegistryAbi,
} from 'verora-sdk';
import { createPublicClient, http, isAddressEqual, type Address, type Hex } from 'viem';
import { buildAnswer } from './answers.js';
import { ConfigError, loadConfig, type Config, type TestAgent } from './config.js';
import { RateLimiter } from './rate-limit.js';

const ENCRYPTED_QUERY_TYPE = 'encrypted';
const MAX_CACHED_OWNERS = 1_000;

function log(level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, time: new Date().toISOString(), message, ...fields });
  if (level === 'error') console.error(line);
  else console.log(line);
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

let config: Config;
try {
  config = loadConfig();
} catch (error) {
  log('error', 'Invalid configuration', { error: error instanceof ConfigError ? error.message : describe(error) });
  process.exit(1);
}

const publicClient = createPublicClient({ chain: config.chain, transport: http(config.rpcUrl) });
const agentsBySlug = new Map(config.agents.map((agent) => [agent.slug, agent]));
const limiter = new RateLimiter(config.rateLimit);

/** Agent owners change rarely, so registry lookups are cached for OWNER_CACHE_TTL_SECONDS */
const ownerCache = new Map<string, { owner: Address; expiresAt: number }>();
async function agentOwner(agentId: Hex): Promise<Address> {
  const key = agentId.toLowerCase();
  const cached = ownerCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.owner;

  const info = await publicClient.readContract({
    address: config.agentRegistry,
    abi: agentRegistryAbi,
    functionName: 'getAgent',
    args: [agentId],
  });
  ownerCache.delete(key);
  if (ownerCache.size >= MAX_CACHED_OWNERS) {
    const oldest = ownerCache.keys().next();
    if (!oldest.done) ownerCache.delete(oldest.value);
  }
  ownerCache.set(key, { owner: info.owner, expiresAt: Date.now() + config.ownerCacheTtlMs });
  return info.owner;
}

/** Produces the response bytes: the canned answer, sealed for the requester when the query is encrypted */
function respond(agent: TestAgent, queryType: string, queryData: Hex, queryId: Hex, createdAt: bigint): Hex {
  if (queryType === ENCRYPTED_QUERY_TYPE) {
    const { prompt, replyPublicKey } = decryptQuery(queryData, agent.encryption.secretKey);
    return encryptResponse(buildAnswer({ queryId, prompt, createdAt }), replyPublicKey);
  }
  return encodeText(buildAnswer({ queryId, prompt: decodeText(queryData), createdAt }));
}

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxyHops);

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', chainId: config.chain.id, agents: config.agents.length });
});

app.use((req: Request, res: Response, next: NextFunction) => {
  const retryAfter = limiter.take(req.ip ?? 'unknown');
  if (retryAfter > 0) {
    res.setHeader('retry-after', String(retryAfter));
    res.status(429).json({ error: 'Too many requests' });
    return;
  }
  next();
});

app.use(express.json({ limit: '64kb' }));

app.get('/agents', (_req: Request, res: Response) => {
  res.json({
    chainId: config.chain.id,
    queryConsumer: config.queryConsumer,
    agents: config.agents.map((agent) => ({
      slug: agent.slug,
      owner: agent.owner.address,
      publicKey: agent.encryption.publicKey,
      endpointPath: `/${agent.slug}/query`,
    })),
  });
});

app.get('/:slug/encryption/public-key', (req: Request<{ slug: string }>, res: Response) => {
  const agent = agentsBySlug.get(req.params.slug);
  if (!agent) {
    res.status(404).json({ error: 'Unknown agent' });
    return;
  }
  res.json({ publicKey: agent.encryption.publicKey, algorithm: 'X25519-XSalsa20-Poly1305' });
});

app.post('/:slug/query', async (req: Request<{ slug: string }>, res: Response) => {
  const agent = agentsBySlug.get(req.params.slug);
  if (!agent) {
    res.status(404).json({ error: 'Unknown agent' });
    return;
  }

  try {
    const request = parseAgentQueryRequest(req.body);
    // Cheap local pin before any RPC work; verifyAgentQueryRequest re-checks both against the chain
    if (request.chainId !== config.chain.id || !isAddressEqual(request.queryConsumer, config.queryConsumer)) {
      res.status(400).json({ error: 'Request targets a different chain or QueryConsumer' });
      return;
    }
    const query = await verifyAgentQueryRequest(
      publicClient,
      { queryConsumer: config.queryConsumer, chainId: config.chain.id },
      request,
    );

    const owner = await agentOwner(request.agentId);
    if (!isAddressEqual(owner, agent.owner.address)) {
      res.status(403).json({ error: 'This endpoint does not answer for that agent' });
      return;
    }

    const responseData = respond(agent, request.queryType, request.queryData, request.queryId, query.createdAt);
    const signed = await signAgentResponse({ signer: agent.owner, request, responseData });
    log('info', 'Answered query', { agent: agent.slug, queryId: request.queryId, agentId: request.agentId });
    res.json(signed);
  } catch (error) {
    if (error instanceof EncryptionError) {
      log('warn', 'Rejected encrypted query', { agent: agent.slug, error: describe(error) });
      res.status(400).json({ error: 'Encrypted query could not be decrypted by this agent' });
      return;
    }
    if (error instanceof AgentProtocolError) {
      // SDK protocol errors carry safe, fixed messages (no internals), so they can be returned as-is
      log('warn', 'Rejected query', { agent: agent.slug, error: describe(error) });
      res.status(400).json({ error: error.message });
      return;
    }
    log('error', 'Failed to answer query', { agent: agent.slug, error: describe(error) });
    res.status(500).json({ error: 'Internal error' });
  }
});

app.use((_req: Request, res: Response) => {
  res.status(404).json({ error: 'Not found' });
});

// Body parser failures carry a 4xx status; everything else is logged and hidden behind a generic 500
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = typeof error === 'object' && error !== null && 'status' in error ? Number(error.status) : 500;
  if (status === 413) {
    res.status(413).json({ error: 'Request body too large' });
    return;
  }
  if (status >= 400 && status < 500) {
    res.status(400).json({ error: 'Invalid request body' });
    return;
  }
  log('error', 'Unhandled error', { error: describe(error) });
  res.status(500).json({ error: 'Internal error' });
});

const server = app.listen(config.port, () => {
  log('info', 'Test agents listening', {
    port: config.port,
    chainId: config.chain.id,
    queryConsumer: config.queryConsumer,
    agents: config.agents.map((agent) => ({ slug: agent.slug, owner: agent.owner.address, publicKey: agent.encryption.publicKey })),
  });
  for (const agent of config.agents.filter((entry) => entry.ephemeralEncryptionKey)) {
    log('warn', 'DEVELOPMENT ONLY: no encryption key configured, using a random key that changes on every restart', {
      agent: agent.slug,
    });
  }
});

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
