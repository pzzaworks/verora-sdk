import { createPublicClient, createWalletClient, http, verifyMessage } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';
import { parseSiweMessage } from 'viem/siwe';
import { describe, expect, it, vi } from 'vitest';
import { VeroraApi } from '../api';
import { VeroraClient } from '../client';
import { parseDeployment } from '../deployment';
import { ApiError, ConfigurationError, InvalidArgumentError, WalletNotConnectedError } from '../errors';

const manifest = {
  chainId: 11155111,
  startBlock: 123,
  owner: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
  finalizer: '0xa0Ee7A142d267C1f36714E4a8F75612F20a79720',
  treasury: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  agentRegistry: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512',
  stakingPool: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  reputationManager: '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9',
  paymentRouter: '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9',
  queryConsumer: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707',
};

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('parseDeployment', () => {
  it('checksums addresses from a manifest', () => {
    const deployment = parseDeployment(manifest);
    expect(deployment.owner).toBe('0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(deployment.startBlock).toBe(123);
  });

  it('rejects incomplete or malformed manifests', () => {
    expect(() => parseDeployment({ ...manifest, queryConsumer: '0x123' })).toThrow(ConfigurationError);
    expect(() => parseDeployment({ ...manifest, chainId: -1 })).toThrow(ConfigurationError);
    expect(() => parseDeployment(null)).toThrow(ConfigurationError);
  });
});

describe('VeroraClient configuration', () => {
  const publicClient = createPublicClient({ chain: foundry, transport: http('http://127.0.0.1:1') });

  it('requires every core contract address', () => {
    expect(
      () => new VeroraClient({ publicClient, contracts: { ...parseDeployment(manifest), stakingPool: '0x0' } }),
    ).toThrow(ConfigurationError);
  });

  it('requires a wallet for writes and an API URL for API calls', async () => {
    const client = new VeroraClient({ publicClient, contracts: parseDeployment(manifest) });
    await expect(client.withdrawFees()).rejects.toThrow(WalletNotConnectedError);
    expect(() => client.api).toThrow(ConfigurationError);
  });
});

describe('VeroraApi', () => {
  it('builds list queries and maps API errors', async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        url.includes('/agents?')
          ? jsonResponse(200, { data: [], page: 2, limit: 5, total: 0 })
          : jsonResponse(404, { message: 'Query not found' }),
      ),
    );
    const api = new VeroraApi('https://api.verora.test/', fetchMock as unknown as typeof fetch);

    await api.listAgents({ page: 2, limit: 5, status: 'active', search: undefined });
    expect(fetchMock.mock.calls[0]?.[0]).toBe('https://api.verora.test/agents?page=2&limit=5&status=active');

    await expect(api.getQuery(`0x${'ab'.repeat(32)}`)).rejects.toEqual(new ApiError(404, 'Query not found'));
  });

  it('maps non-JSON bodies to ApiError', async () => {
    const fetchMock = vi.fn((url: string) =>
      Promise.resolve(
        url.endsWith('/queries/stats')
          ? new Response('<html>ok</html>', { status: 200 })
          : new Response('<html>Bad Gateway</html>', { status: 502, statusText: 'Bad Gateway' }),
      ),
    );
    const api = new VeroraApi('https://api.verora.test', fetchMock as unknown as typeof fetch);

    await expect(api.listAgents()).rejects.toEqual(new ApiError(502, 'Bad Gateway'));
    await expect(api.getNetworkStats()).rejects.toBeInstanceOf(ApiError);
  });

  it('validates ids and addresses before building URL paths', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(200, {})));
    const api = new VeroraApi('https://api.verora.test', fetchMock as unknown as typeof fetch);

    expect(() => api.getAgent('../auth/nonce' as `0x${string}`)).toThrow(InvalidArgumentError);
    expect(() => api.getQuery('0x1234')).toThrow(InvalidArgumentError);
    expect(() => api.getAgentStakingStats(`0x${'zz'.repeat(32)}`)).toThrow(InvalidArgumentError);
    expect(() => api.getStakePositions('0xnot-an-address')).toThrow(InvalidArgumentError);
    await api.getStakePositions('0xF39Fd6e51aad88F6F4ce6aB8827279cffFb92266');
    expect(fetchMock).toHaveBeenCalledWith('https://api.verora.test/staking/positions/0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266', expect.anything());
  });

  it('signs in with SIWE and authenticates metadata uploads', async () => {
    const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
    const walletClient = createWalletClient({ account, chain: foundry, transport: http('http://127.0.0.1:1') });
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/auth/nonce')) return jsonResponse(200, { nonce: 'abcdefgh12345678' });
      if (url.endsWith('/auth/verify')) {
        const { message, signature } = JSON.parse(String(init?.body)) as { message: string; signature: `0x${string}` };
        const fields = parseSiweMessage(message);
        const valid = await verifyMessage({ address: account.address, message, signature });
        expect(fields.domain).toBe('app.verora.test');
        expect(fields.nonce).toBe('abcdefgh12345678');
        return jsonResponse(valid ? 200 : 401, { token: 'session', address: account.address, expiresIn: 3600 });
      }
      const headers = new Headers(init?.headers);
      return jsonResponse(headers.get('authorization') === 'Bearer session' ? 201 : 401, { id: '1', uri: 'u' });
    });
    const api = new VeroraApi('https://api.verora.test', fetchMock as unknown as typeof fetch);

    await expect(api.uploadMetadata({ name: 'a', description: 'b' })).rejects.toThrow(ConfigurationError);
    await api.signIn(walletClient, { domain: 'app.verora.test', uri: 'https://app.verora.test', chainId: 31337 });
    expect(api.isSignedIn).toBe(true);
    await expect(api.uploadMetadata({ name: 'a', description: 'b' })).resolves.toEqual({ id: '1', uri: 'u' });
  });
});
