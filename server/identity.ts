import { generateKeyPairSync, createPublicKey, createPrivateKey, createHash, sign as cryptoSign, verify as cryptoVerify, type KeyObject } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';

// A node's cryptographic identity. Each node is its own authority: it signs SSO
// vouchers with its private key, and peers verify them against the gossiped pubkey.
export interface Identity {
  nodeId: string;         // hex sha256 of the SPKI DER, truncated
  publicKeyB64: string;   // base64url SPKI DER — this is what gets gossiped
  privateKey: KeyObject;
  publicKey: KeyObject;
  sign(msg: Buffer | string): string;  // base64url Ed25519 signature
}

const toBuf = (m: Buffer | string): Buffer => (typeof m === 'string' ? Buffer.from(m) : m);

function spkiB64(publicKey: KeyObject): string {
  return (publicKey.export({ format: 'der', type: 'spki' }) as Buffer).toString('base64url');
}

function makeIdentity(privateKey: KeyObject): Identity {
  const publicKey = createPublicKey(privateKey);
  const der = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  const publicKeyB64 = der.toString('base64url');
  const nodeId = createHash('sha256').update(der).digest('hex').slice(0, 16);
  return {
    nodeId,
    publicKeyB64,
    privateKey,
    publicKey,
    sign: (msg) => cryptoSign(null, toBuf(msg), privateKey).toString('base64url'),
  };
}

// Load the node key from NODE_KEY (base64 PKCS8 DER) or a keyfile, generating and
// persisting a fresh Ed25519 keypair if none exists. NEVER logs private material.
export function loadOrCreateIdentity(keyFile = path.join('data', 'node.key')): Identity {
  const envKey = process.env.NODE_KEY;
  if (envKey) {
    const der = Buffer.from(envKey, 'base64');
    return makeIdentity(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' }));
  }
  try {
    const pem = readFileSync(keyFile, 'utf-8');
    return makeIdentity(createPrivateKey(pem));
  } catch { /* fall through to generate */ }

  const { privateKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }) as string;
  try {
    mkdirSync(path.dirname(keyFile), { recursive: true });
    writeFileSync(keyFile, pem, { mode: 0o600 });
  } catch (e) {
    console.log('[identity] could not persist key to', keyFile, '-', (e as Error).message);
  }
  const id = makeIdentity(privateKey);
  console.log('[identity] generated node key — pubkey:', id.publicKeyB64);
  console.log('[identity] node id:', id.nodeId);
  console.log('[identity] private key written to', keyFile, '— set NODE_KEY (base64 PKCS8) to relocate/persist it');
  return id;
}

// Verify an Ed25519 signature made by the holder of `pubKeyB64` (base64url SPKI DER).
export function verifySig(pubKeyB64: string, msg: Buffer | string, sigB64: string): boolean {
  try {
    const pub = createPublicKey({ key: Buffer.from(pubKeyB64, 'base64url'), format: 'der', type: 'spki' });
    return cryptoVerify(null, toBuf(msg), pub, Buffer.from(sigB64, 'base64url'));
  } catch {
    return false;
  }
}

export { spkiB64 };
