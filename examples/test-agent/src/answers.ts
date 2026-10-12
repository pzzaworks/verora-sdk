/**
 * Canned test answers. Every answer is a pure function of the on-chain query (prompt, query ID, and
 * creation time), so all test agents assigned to the same query return byte-identical responses and
 * the oracle's consensus accepts all of them. Answers are labelled as test data and are never real.
 */
import { keccak256, stringToBytes, type Hex } from 'viem';

export const TEST_DATA_NOTICE = 'Deterministic test answer from a Verora test agent. This is not real data.';

interface Topic {
  id: string;
  keywords: string[];
  data: Record<string, unknown>;
}

/** Checked in order: the first topic with a keyword contained in the prompt wins */
const TOPICS: Topic[] = [
  { id: 'eth_usd', keywords: ['eth/usd'], data: { pair: 'ETH/USD', price: 2500, bid: 2499.5, ask: 2500.5 } },
  { id: 'btc_usd', keywords: ['btc/usd'], data: { pair: 'BTC/USD', price: 45000, bid: 44990, ask: 45010 } },
  {
    id: 'market_cap',
    keywords: ['market cap'],
    data: { ethMarketCapUsd: 300_000_000_000, btcMarketCapUsd: 900_000_000_000, totalMarketCapUsd: 1_500_000_000_000 },
  },
  { id: 'eth_price', keywords: ['eth price'], data: { symbol: 'ETH', price: 2500, currency: 'USD' } },
  { id: 'btc_price', keywords: ['btc price', 'btc'], data: { symbol: 'BTC', price: 45000, currency: 'USD' } },
  { id: 'gas', keywords: ['gas'], data: { low: 15, medium: 25, high: 40, baseFee: 20, unit: 'gwei' } },
  { id: 'weather', keywords: ['weather', 'forecast', 'rain'], data: { temperatureC: 22, condition: 'sunny', humidity: 65, windKph: 12 } },
  {
    id: 'sentiment',
    keywords: ['sentiment'],
    data: { sentiment: 'neutral', score: 0.5, signals: ['test_signal_a', 'test_signal_b'] },
  },
];

const DEFAULT_TOPIC: Topic = {
  id: 'general',
  keywords: [],
  data: { result: 'canned test response', confidence: 1 },
};

export interface AnswerInput {
  queryId: Hex;
  prompt: string;
  /** On-chain `createdAt` of the query (unix seconds) */
  createdAt: bigint;
}

/** Builds the JSON answer text for a query */
export function buildAnswer({ queryId, prompt, createdAt }: AnswerInput): string {
  const normalized = prompt.toLowerCase();
  const topic = TOPICS.find(({ keywords }) => keywords.some((keyword) => normalized.includes(keyword))) ?? DEFAULT_TOPIC;
  return JSON.stringify({
    testData: true,
    notice: TEST_DATA_NOTICE,
    topic: topic.id,
    data: topic.data,
    queryId,
    promptHash: keccak256(stringToBytes(prompt)),
    asOf: new Date(Number(createdAt) * 1000).toISOString(),
  });
}
