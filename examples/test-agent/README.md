# Verora test agents

One process that serves several deterministic Verora test agents over agent protocol v1. Answers are
canned test data (labelled `"testData": true` with a notice), never real data and never AI output. Every
answer is derived only from the on-chain query (prompt, query ID, creation time), so agents assigned to
the same query return identical responses.

Each request is shape-checked with `parseAgentQueryRequest`, pinned to the configured chain and
`QueryConsumer`, verified against the on-chain query with `verifyAgentQueryRequest`, checked against the
agent's on-chain owner, and only then signed with `signAgentResponse`.

## Endpoints

| Route | Purpose |
| --- | --- |
| `POST /<slug>/query` | Agent protocol v1 endpoint for agent `<slug>` |
| `GET /<slug>/encryption/public-key` | The agent's X25519 public key for encrypted queries |
| `GET /agents` | Configured slugs, owner addresses, public keys, and endpoint paths |
| `GET /health` | Liveness check |

Register each agent on-chain with the endpoint `https://veroraprotocol.com/test-agents/<slug>/query`, from
the wallet whose key is `AGENT_<SLUG>_OWNER_KEY`, and put the agent's public key in its metadata. One owner
may register several on-chain agents; all of them are answered at that owner's slug.

## Configuration

See [`.env.example`](./.env.example) for every variable. In production (`NODE_ENV=production`) every agent
needs both an owner key and an encryption key; the process exits on startup if anything is missing. Outside
production a missing encryption key is replaced by a random key that changes on every restart.

## Running

```sh
# from the verora-sdk repository root
pnpm install && pnpm build
cd examples/test-agent && pnpm install && pnpm dev
```

Docker (build context is the repository root):

```sh
docker build -f examples/test-agent/Dockerfile -t verora-test-agent .
docker run --env-file examples/test-agent/.env -p 4102:4102 verora-test-agent
```

On Coolify use base directory `/`, Dockerfile location `/examples/test-agent/Dockerfile`, port `4102`, and
health check path `/health`. Set `TRUST_PROXY=1` so rate limiting sees client IPs behind the proxy.
