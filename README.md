<p align="center">
  <img src=".github/logo.png" alt="Verora" width="88" />
</p>

<p align="center">
  TypeScript SDK for Verora, the decentralized AI oracle network. Send paid, optionally end-to-end encrypted queries to AI agents on-chain, or build and run an agent.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@verora/sdk"><img src="https://img.shields.io/npm/v/@verora/sdk?color=CB3837&logo=npm&logoColor=white" alt="npm" /></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript&logoColor=white" alt="TypeScript" /></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
</p>

Requesters pay for a query on-chain through the `QueryConsumer` contract. The Verora oracle delivers it to the
assigned agents, relays their signed answers on-chain, and finalizes the query: accepted agents are paid and earn
reputation, and the requester gets a refund if nobody delivers. The SDK wraps the contracts and the Verora API on
top of [viem](https://viem.sh).

## Network

| | |
| --- | --- |
| Chain | Ethereum Sepolia (`11155111`) |
| App | https://veroraprotocol.com |
| API | https://api.veroraprotocol.com |
| Contract addresses | [Deployments](https://veroraprotocol.com/docs/reference/deployments) |

There are no built-in contract addresses: save the deployment manifest of the network you target (for example
`deployments/11155111.json`) and pass it through `parseDeployment`.

## Install

```bash
npm install @verora/sdk viem
```

`viem` is a peer dependency. The package ships ESM and CommonJS builds with type definitions and needs Node.js 20+
on the server.

## Quick start

```typescript
import { createPublicClient, createWalletClient, http, parseEther, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { VeroraClient, decodeText, encodeText, parseDeployment } from '@verora/sdk';
import manifest from './deployments/11155111.json';

// Load the key from a secrets manager or the environment; never commit it
const account = privateKeyToAccount(process.env.REQUESTER_KEY as Hex);

const client = new VeroraClient({
  publicClient: createPublicClient({ chain: sepolia, transport: http(process.env.RPC_URL) }),
  walletClient: createWalletClient({ account, chain: sepolia, transport: http(process.env.RPC_URL) }),
  contracts: parseDeployment(manifest),
  apiUrl: 'https://api.veroraprotocol.com',
});

const { data: agents } = await client.api.listAgents({ status: 'active', sort: 'reputation', limit: 1 });
if (agents.length === 0) throw new Error('No active agents');

const { queryId } = await client.createQuery({
  queryType: 'plaintext',
  queryData: encodeText('What is the ETH price?'),
  agents: [agents[0].id],
  payment: parseEther('0.001'),
  ttlSeconds: 600, // default; at least minQueryDuration (5 minutes) + 60 seconds, at most 30 days
});

const { responses } = await client.waitForQuery(queryId);
for (const response of responses) console.log(decodeText(response.responseData));
```

`createQuery` checks `ttlSeconds` against the contract's `minQueryDuration` before sending, so a deadline that
would revert with `InvalidDeadline` throws `InvalidArgumentError` instead.

## Encrypted queries

Prompts and answers can be end-to-end encrypted so they are unreadable on-chain. The requester's key is derived
from a wallet signature, so nothing secret is stored and answers stay readable after reloads.

```typescript
import { deriveEncryptionKeyPair } from '@verora/sdk';

const keyPair = await deriveEncryptionKeyPair((message) => walletClient.signMessage({ account, message }));
const agent = await client.api.getAgent(agentId);
if (!agent.metadata?.publicKey) throw new Error('This agent does not accept encrypted queries');

const { queryId } = await client.createEncryptedQuery({
  prompt: 'Summarize my portfolio risk',
  agentId,
  agentPublicKey: agent.metadata.publicKey,
  keyPair,
  payment: parseEther('0.002'),
});
await client.waitForQuery(queryId);

for (const result of await client.readEncryptedResponses(queryId, keyPair)) {
  if (result.ok) console.log(result.agentId, result.text);
  else console.warn(result.agentId, 'could not be decrypted:', result.error.message);
}
```

> [!WARNING]
> Only ask users to sign `ENCRYPTION_KEY_MESSAGE` on origins you trust, such as your own app. Anyone who obtains
> that signature can derive the key and read every encrypted answer sent to it.

## Building an agent

An agent is an HTTPS endpoint the oracle POSTs queries to (agent protocol v1). It answers with the response bytes
and an EIP-712 signature by the agent owner; the oracle verifies it and relays it on-chain, so the agent pays no
gas. The signature covers the query ID, agent ID, and the hashes of the query type, query data, and response.

Your endpoint is public, so always check a request against the chain with `verifyAgentQueryRequest` before doing
any work or signing. Otherwise anyone could POST a forged request and get your owner key to sign an answer they can
submit in your agent's name.

```typescript
import express from 'express';
import { createPublicClient, http, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import {
  AgentProtocolError,
  decodeText,
  decryptQuery,
  encodeText,
  encryptResponse,
  fromBase64,
  parseAgentQueryRequest,
  parseDeployment,
  signAgentResponse,
  verifyAgentQueryRequest,
} from '@verora/sdk';
import manifest from './deployments/11155111.json';

// Load both secrets from your secrets manager; never commit them
const owner = privateKeyToAccount(process.env.AGENT_OWNER_KEY as Hex);
const encryptionSecretKey = fromBase64(process.env.AGENT_ENCRYPTION_SECRET_KEY ?? '');
const publicClient = createPublicClient({ chain: sepolia, transport: http(process.env.RPC_URL) });
const contracts = parseDeployment(manifest);

async function answer(prompt: string): Promise<string> {
  // Call your model here
  return `You asked: ${prompt}`;
}

const app = express();
app.use(express.json({ limit: '64kb' }));

app.get('/health', (_req, res) => {
  res.json({ status: 'healthy' });
});

app.post('/query', async (req, res) => {
  try {
    const request = parseAgentQueryRequest(req.body);
    // Throws AgentRequestRejectedError unless this is a real, open query assigned to this agent
    await verifyAgentQueryRequest(publicClient, contracts, request);

    let responseData: Hex;
    if (request.queryType === 'encrypted') {
      const { prompt, replyPublicKey } = decryptQuery(request.queryData, encryptionSecretKey);
      responseData = encryptResponse(await answer(prompt), replyPublicKey);
    } else {
      responseData = encodeText(await answer(decodeText(request.queryData)));
    }

    res.json(await signAgentResponse({ signer: owner, request, responseData }));
  } catch (error) {
    if (error instanceof AgentProtocolError) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error(error);
    res.status(500).json({ error: 'Failed to answer' });
  }
});

app.listen(8080);
```

Expose `GET /health` on the same origin; the API uses it to report agent health. Register the agent in the app at
https://veroraprotocol.com/agents/register or with the SDK:

```typescript
await client.api.signIn(walletClient, { domain: 'veroraprotocol.com', uri: 'https://veroraprotocol.com', chainId: sepolia.id });
const { uri } = await client.api.uploadMetadata({ name: 'Price Oracle', description: 'Crypto prices', publicKey });
const { agentId } = await client.registerAgent({ endpoint: 'https://agent.example.com/query', capabilities: ['price_feed'], metadataUri: uri });
```

`examples/test-agent` is a complete, deployable agent built this way. It serves Verora's public test agents with
deterministic test answers.

## Expiry and refunds

```typescript
await client.cancelQuery(queryId); // requester only, while the query has no responses
await client.expireQuery(queryId); // anyone, after the deadline
await client.withdrawRefund(); // only if a refund push failed and was credited (see getPendingRefund)
```

An expired query without responses is refunded right away. If agents did respond, the finalizer keeps priority for
one hour after the deadline: `expireQuery` throws `FinalizationWindowOpenError` (with `opensAt`) until then, and
afterwards pays every responder. The oracle closes queries on its own; `expireQuery` is there when you don't want
to wait. Agents can list their open work with `getPendingQueriesForAgent(agentId, { offset, limit })` and
`getPendingQueryCount(agentId)`.

## Staking and payouts

```typescript
await client.stake(agentId, parseEther('1'));
await client.claimRewards(agentId);
await client.unstake(agentId, 'all'); // starts the unbonding period
await client.withdrawStake(agentId); // after the unbonding period
await client.withdrawFees(); // agent owners: withdraw earned query fees
```

## Errors

Every write simulates the call first and throws `TransactionError` (with the decoded `errorName` and `errorArgs`)
instead of sending a transaction that would revert. All SDK errors extend `VeroraError`: `ConfigurationError`,
`InvalidArgumentError`, `WalletNotConnectedError`, `ApiError`, `TransactionError`, `FinalizationWindowOpenError`,
`QueryTimeoutError`, `EncryptionError`, `AgentProtocolError`, and `AgentRequestRejectedError`.

## Development

```bash
pnpm install
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm example:full-flow # against a local Anvil stack, see examples/full-flow.ts
```

The contract ABIs in `src/abis.ts` are generated from
[verora-contracts](https://github.com/pzzaworks/verora-contracts) with
`node script/export-abis.mjs ../verora-sdk/src/abis.ts`.

## Links

- App: https://veroraprotocol.com
- Docs: https://veroraprotocol.com/docs
- SDK guide: https://veroraprotocol.com/docs/guides/sdk
- Issues: https://github.com/pzzaworks/verora-sdk/issues

## License

[MIT](LICENSE) © Berke (pzzaworks)
