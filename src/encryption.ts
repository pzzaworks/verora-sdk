import nacl from 'tweetnacl';
import { hexToBytes, sha256, toHex, type Hex } from 'viem';
import { EncryptionError } from './errors';

/**
 * End-to-end encryption for Verora queries (X25519 + XSalsa20-Poly1305 via tweetnacl).
 *
 * Wire format (UTF-8 JSON stored as the query/response bytes on-chain):
 * - encrypted query:    { ciphertext, nonce, ephemeralPublicKey, replyPublicKey }
 * - encrypted response: { ciphertext, nonce, ephemeralPublicKey }
 * All fields are base64. Every message uses a fresh ephemeral sender key. `replyPublicKey` is the
 * requester's long-lived encryption key that the agent encrypts its response to.
 */

/** Message a wallet signs to derive its encryption key. Must stay identical across app, SDK, and agents. */
export const ENCRYPTION_KEY_MESSAGE =
  'Verora encryption key v1\n\nSign to unlock end-to-end encrypted queries. This does not send a transaction or cost gas.';

export interface EncryptionKeyPair {
  publicKey: string;
  secretKey: Uint8Array;
}

export interface EncryptedMessage {
  ciphertext: string;
  nonce: string;
  ephemeralPublicKey: string;
}

export interface EncryptedQuery extends EncryptedMessage {
  replyPublicKey: string;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

/** Decodes standard (padded) base64; throws `EncryptionError` on anything else */
export function fromBase64(value: string): Uint8Array {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
    throw new EncryptionError('Invalid base64');
  }
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

export function isValidPublicKey(publicKey: string): boolean {
  try {
    return fromBase64(publicKey).length === nacl.box.publicKeyLength;
  } catch {
    return false;
  }
}

/**
 * Derives a deterministic encryption key pair from a wallet signature of `ENCRYPTION_KEY_MESSAGE`.
 * The same wallet always gets the same key, so responses stay decryptable after reloads without
 * storing any secret. Requires a deterministic signer (standard EOAs sign deterministically).
 *
 * Only ask users to sign `ENCRYPTION_KEY_MESSAGE` on origins you trust (your own app or backend): anyone who
 * obtains that signature can derive the key and read every encrypted answer sent to it.
 */
export async function deriveEncryptionKeyPair(signMessage: (message: string) => Promise<Hex>): Promise<EncryptionKeyPair> {
  const signature = await signMessage(ENCRYPTION_KEY_MESSAGE);
  const seed = hexToBytes(sha256(signature));
  const keyPair = nacl.box.keyPair.fromSecretKey(seed);
  return { publicKey: toBase64(keyPair.publicKey), secretKey: keyPair.secretKey };
}

/** Generates a random key pair (agents typically use one long-lived key pair) */
export function generateEncryptionKeyPair(): EncryptionKeyPair {
  const keyPair = nacl.box.keyPair();
  return { publicKey: toBase64(keyPair.publicKey), secretKey: keyPair.secretKey };
}

function seal(plaintext: string, recipientPublicKey: string): EncryptedMessage {
  if (!isValidPublicKey(recipientPublicKey)) throw new EncryptionError('Invalid recipient public key');
  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ciphertext = nacl.box(new TextEncoder().encode(plaintext), nonce, fromBase64(recipientPublicKey), ephemeral.secretKey);
  return { ciphertext: toBase64(ciphertext), nonce: toBase64(nonce), ephemeralPublicKey: toBase64(ephemeral.publicKey) };
}

/** Decoded binary fields of an encrypted message, length-checked */
interface SealedBox {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  ephemeralPublicKey: Uint8Array;
}

function decodeField(record: ReadonlyMap<string, unknown>, field: keyof EncryptedQuery, expectedLength?: number): Uint8Array {
  const value = record.get(field);
  if (typeof value !== 'string') throw new EncryptionError(`Encrypted message has no ${field}`);
  const bytes = fromBase64(value);
  if (expectedLength !== undefined && bytes.length !== expectedLength) throw new EncryptionError(`Encrypted message has an invalid ${field}`);
  return bytes;
}

function toSealedBox(record: ReadonlyMap<string, unknown>): SealedBox {
  const ciphertext = decodeField(record, 'ciphertext');
  if (ciphertext.length < nacl.box.overheadLength) throw new EncryptionError('Encrypted message has an invalid ciphertext');
  return {
    ciphertext,
    nonce: decodeField(record, 'nonce', nacl.box.nonceLength),
    ephemeralPublicKey: decodeField(record, 'ephemeralPublicKey', nacl.box.publicKeyLength),
  };
}

function open(box: SealedBox, secretKey: Uint8Array): string {
  if (!(secretKey instanceof Uint8Array) || secretKey.length !== nacl.box.secretKeyLength) throw new EncryptionError('Invalid secret key');
  const plaintext = nacl.box.open(box.ciphertext, box.nonce, box.ephemeralPublicKey, secretKey);
  if (!plaintext) throw new EncryptionError('Decryption failed: wrong key or tampered ciphertext');
  return new TextDecoder().decode(plaintext);
}

function parseMessage(bytes: Hex): ReadonlyMap<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(hexToBytes(bytes)));
  } catch {
    throw new EncryptionError('Payload is not an encrypted Verora message');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new EncryptionError('Payload is not an encrypted Verora message');
  return new Map<string, unknown>(Object.entries(value));
}

function encodeJson(value: object): Hex {
  return toHex(new TextEncoder().encode(JSON.stringify(value)));
}

/** Runs a crypto step and reports any failure as `EncryptionError` */
function guard<T>(step: () => T): T {
  try {
    return step();
  } catch (error) {
    if (error instanceof EncryptionError) throw error;
    throw new EncryptionError(error instanceof Error ? error.message : 'Encryption failed');
  }
}

/** Requester side: encrypts a prompt for an agent; the result is the `queryData` of an `encrypted` query */
export function encryptQuery(prompt: string, agentPublicKey: string, replyPublicKey: string): Hex {
  return guard(() => {
    if (!isValidPublicKey(replyPublicKey)) throw new EncryptionError('Invalid reply public key');
    const query: EncryptedQuery = { ...seal(prompt, agentPublicKey), replyPublicKey };
    return encodeJson(query);
  });
}

/** Requester side: decrypts an agent's response bytes. Throws `EncryptionError` on any malformed or foreign payload. */
export function decryptResponse(responseData: Hex, secretKey: Uint8Array): string {
  return guard(() => open(toSealedBox(parseMessage(responseData)), secretKey));
}

/** Agent side: decrypts an encrypted query and returns the prompt plus the key to answer to */
export function decryptQuery(queryData: Hex, agentSecretKey: Uint8Array): { prompt: string; replyPublicKey: string } {
  return guard(() => {
    const record = parseMessage(queryData);
    const replyPublicKey = record.get('replyPublicKey');
    if (typeof replyPublicKey !== 'string' || !isValidPublicKey(replyPublicKey)) {
      throw new EncryptionError('Encrypted query has no valid replyPublicKey');
    }
    return { prompt: open(toSealedBox(record), agentSecretKey), replyPublicKey };
  });
}

/** Agent side: encrypts a response for the requester; the result is the agent's `responseData` */
export function encryptResponse(response: string, replyPublicKey: string): Hex {
  return guard(() => encodeJson(seal(response, replyPublicKey)));
}

/** Plaintext helpers for non-encrypted queries */
export function encodeText(text: string): Hex {
  return toHex(new TextEncoder().encode(text));
}

export function decodeText(data: Hex): string {
  return new TextDecoder().decode(hexToBytes(data));
}
