import { privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it } from 'vitest';
import {
  decodeText,
  decryptQuery,
  decryptResponse,
  deriveEncryptionKeyPair,
  encodeText,
  encryptQuery,
  encryptResponse,
  fromBase64,
  generateEncryptionKeyPair,
  isValidPublicKey,
  toBase64,
} from '../encryption';
import { EncryptionError } from '../errors';

const requester = privateKeyToAccount('0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a');

describe('encryption', () => {
  it('derives the same key pair from the same wallet every time', async () => {
    const sign = (message: string) => requester.signMessage({ message });
    const first = await deriveEncryptionKeyPair(sign);
    const second = await deriveEncryptionKeyPair(sign);

    expect(first.publicKey).toBe(second.publicKey);
    expect(isValidPublicKey(first.publicKey)).toBe(true);
  });

  it('round-trips an encrypted query and response between requester and agent', async () => {
    const requesterKeys = await deriveEncryptionKeyPair((message) => requester.signMessage({ message }));
    const agentKeys = generateEncryptionKeyPair();

    const queryData = encryptQuery('What is the BTC price?', agentKeys.publicKey, requesterKeys.publicKey);
    expect(decodeText(queryData)).not.toContain('BTC');

    const { prompt, replyPublicKey } = decryptQuery(queryData, agentKeys.secretKey);
    expect(prompt).toBe('What is the BTC price?');
    expect(replyPublicKey).toBe(requesterKeys.publicKey);

    const responseData = encryptResponse('{"price":45000}', replyPublicKey);
    expect(decryptResponse(responseData, requesterKeys.secretKey)).toBe('{"price":45000}');
  });

  it('fails closed on the wrong key, tampering, and invalid input', () => {
    const agentKeys = generateEncryptionKeyPair();
    const replyKeys = generateEncryptionKeyPair();
    const responseData = encryptResponse('secret', replyKeys.publicKey);

    expect(() => decryptResponse(responseData, generateEncryptionKeyPair().secretKey)).toThrow(EncryptionError);

    const sealed = JSON.parse(decodeText(responseData)) as { ciphertext: string };
    const bytes = fromBase64(sealed.ciphertext);
    bytes[0] ^= 0xff;
    const tampered = encodeText(JSON.stringify({ ...JSON.parse(decodeText(responseData)), ciphertext: toBase64(bytes) }));
    expect(() => decryptResponse(tampered, replyKeys.secretKey)).toThrow(EncryptionError);

    expect(() => encryptQuery('x', 'not-a-key', replyKeys.publicKey)).toThrow(EncryptionError);
    expect(() => encryptQuery('x', agentKeys.publicKey, 'not-a-key')).toThrow(EncryptionError);
    expect(() => decryptResponse(encodeText('plain text'), replyKeys.secretKey)).toThrow(EncryptionError);
  });

  it('rejects malformed encrypted payloads with EncryptionError', () => {
    const keys = generateEncryptionKeyPair();
    const sealed = JSON.parse(decodeText(encryptResponse('secret', keys.publicKey))) as Record<string, string>;
    const variants: unknown[] = [
      [],
      42,
      { ...sealed, nonce: undefined },
      { ...sealed, nonce: toBase64(new Uint8Array(12)) },
      { ...sealed, ephemeralPublicKey: toBase64(new Uint8Array(31)) },
      { ...sealed, ciphertext: 'not base64!' },
      { ...sealed, ciphertext: toBase64(new Uint8Array(4)) },
    ];
    for (const variant of variants) {
      expect(() => decryptResponse(encodeText(JSON.stringify(variant)), keys.secretKey)).toThrow(EncryptionError);
    }
    expect(() => decryptResponse(encodeText(JSON.stringify(sealed)), new Uint8Array(5))).toThrow(EncryptionError);
    expect(() => decryptQuery(encodeText(JSON.stringify(sealed)), keys.secretKey)).toThrow(EncryptionError);
    expect(() => fromBase64('abc')).toThrow(EncryptionError);
  });

  it('encodes base64 compatibly with Node', () => {
    const bytes = new Uint8Array([0, 1, 2, 250, 255]);
    expect(toBase64(bytes)).toBe(Buffer.from(bytes).toString('base64'));
    expect(Array.from(fromBase64(toBase64(bytes)))).toEqual(Array.from(bytes));
  });
});
