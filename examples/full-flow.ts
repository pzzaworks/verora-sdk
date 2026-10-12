/**
 * Full Verora flow: registers an agent, stakes on it, sends a plaintext and an encrypted query, waits for the
 * oracle to settle them, and withdraws the agent fees.
 *
 * Local Anvil stack (default, `./startup.sh` in the Verora workspace):
 *
 *   DEPLOYMENT=../verora-contracts/deployments/31337.json pnpm example:full-flow
 *
 *   Local mode signs with the public Anvil development keys below. They are published with Foundry, hold no
 *   real funds, and must never be used on a public network.
 *
 * Ethereum Sepolia:
 *
 *   CHAIN=sepolia RPC_URL=... DEPLOYMENT=./deployments/11155111.json \
 *   OWNER_KEY=... REQUESTER_KEY=... AGENT_ENDPOINT=https://your-agent.example.com/query \
 *   API_URL=https://api.veroraprotocol.com APP_ORIGIN=https://veroraprotocol.com pnpm example:full-flow
 *
 *   Sepolia mode only reads keys from the environment; both accounts need Sepolia ETH.
 */
import { readFileSync } from 'node:fs';
import { createPublicClient, createWalletClient, http, isHex, parseEther, type Hex, type PrivateKeyAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry, sepolia } from 'viem/chains';
import { VeroraClient, decodeText, deriveEncryptionKeyPair, encodeText, parseDeployment } from '../src';

const isSepolia = process.env.CHAIN === 'sepolia';
const chain = isSepolia ? sepolia : foundry;

// Public Anvil development keys (accounts 1 and 4). LOCAL ANVIL ONLY: never fund or reuse them anywhere else.
const ANVIL_OWNER_KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ANVIL_REQUESTER_KEY: Hex = '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a';

function keyFromEnv(name: string, localDefault: Hex): Hex {
  const value = process.env[name];
  if (value === undefined || value === '') {
    if (isSepolia) throw new Error(`${name} is required when CHAIN=sepolia`);
    return localDefault;
  }
  if (!isHex(value) || value.length !== 66) throw new Error(`${name} must be a 32-byte hex private key`);
  return value;
}

function required(name: string, localDefault: string): string {
  const value = process.env[name];
  if (value) return value;
  if (isSepolia) throw new Error(`${name} is required when CHAIN=sepolia`);
  return localDefault;
}

const RPC_URL = required('RPC_URL', 'http://localhost:8545');
const API_URL = required('API_URL', 'http://localhost:4100');
const APP_ORIGIN = required('APP_ORIGIN', 'http://localhost:4101');
const AGENT_ENDPOINT = required('AGENT_ENDPOINT', 'http://localhost:4102/alpha/query');
const deployment = parseDeployment(JSON.parse(readFileSync(required('DEPLOYMENT', '../verora-contracts/deployments/31337.json'), 'utf8')));
if (deployment.chainId !== chain.id) throw new Error(`Deployment is for chain ${deployment.chainId}, expected ${chain.id}`);

// The agent owner must be the key the agent server signs with; the requester sends and pays for queries
const owner = privateKeyToAccount(keyFromEnv('OWNER_KEY', ANVIL_OWNER_KEY));
const requester = privateKeyToAccount(keyFromEnv('REQUESTER_KEY', ANVIL_REQUESTER_KEY));

const publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
const walletFor = (account: PrivateKeyAccount) => createWalletClient({ account, chain, transport: http(RPC_URL) });
const clientFor = (account: PrivateKeyAccount) =>
  new VeroraClient({ publicClient, walletClient: walletFor(account), contracts: deployment, apiUrl: API_URL });

async function main() {
  const ownerClient = clientFor(owner);
  const requesterClient = clientFor(requester);

  // 1. Host metadata (SIWE sign-in) and register the agent on-chain
  await ownerClient.api.signIn(walletFor(owner), { domain: new URL(APP_ORIGIN).host, uri: APP_ORIGIN, chainId: chain.id });
  const agentKey = (await fetch(new URL('encryption/public-key', AGENT_ENDPOINT)).then((r) => r.json())) as { publicKey: string };
  const { uri } = await ownerClient.api.uploadMetadata({
    name: 'Example Agent',
    description: 'Registered by the SDK example',
    publicKey: agentKey.publicKey,
  });
  const { agentId } = await ownerClient.registerAgent({ endpoint: AGENT_ENDPOINT, capabilities: ['general'], metadataUri: uri });
  console.log('Registered agent', agentId);

  // 2. Stake behind the agent
  await requesterClient.stake(agentId, parseEther('0.01'));
  console.log('Staked 0.01 ETH');

  // 3. Plaintext query (ttlSeconds defaults to 10 minutes; the contract minimum is 5 minutes)
  const plain = await requesterClient.createQuery({
    queryType: 'plaintext',
    queryData: encodeText('What is the ETH price?'),
    agents: [agentId],
    payment: parseEther('0.001'),
  });
  const plainResult = await requesterClient.waitForQuery(plain.queryId);
  for (const response of plainResult.responses) console.log('Plaintext answer:', decodeText(response.responseData));

  // 4. End-to-end encrypted query
  const keyPair = await deriveEncryptionKeyPair((message) => walletFor(requester).signMessage({ message }));
  const secret = await requesterClient.createEncryptedQuery({
    prompt: 'What is the BTC price?',
    agentId,
    agentPublicKey: agentKey.publicKey,
    keyPair,
    payment: parseEther('0.001'),
  });
  await requesterClient.waitForQuery(secret.queryId);
  for (const result of await requesterClient.readEncryptedResponses(secret.queryId, keyPair)) {
    console.log('Encrypted answer:', result.ok ? result.text : `failed to decrypt (${result.error.message})`);
  }

  // 5. The agent owner withdraws earned fees
  const fees = await ownerClient.getPendingFees(owner.address);
  console.log('Pending fees (wei):', fees);
  if (fees > 0n) {
    await ownerClient.withdrawFees();
    console.log('Fees withdrawn');
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
