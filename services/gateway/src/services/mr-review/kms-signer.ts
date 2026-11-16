/**
 * AWS KMS adapter for the reviewer attestation key. The key must be an
 * ECC_NIST_P256 key with usage SIGN_VERIFY. It signs with ECDSA_SHA_256 and
 * RAW messages, so KMS hashes the message with SHA-256, the same digest the
 * verifier checks. The client is injected: the gateway passes an AWS SDK v3
 * KMSClient's send() bound to the approved reviewer role. Tests pass a mock.
 */
import { createPublicKey } from 'node:crypto';
import type { AttestationSigner } from './attestation.ts';

export interface KmsCommandLike {
  name: 'SignCommand' | 'GetPublicKeyCommand';
  input: Record<string, unknown>;
}
export interface KmsSendLike {
  send(command: KmsCommandLike): Promise<Record<string, unknown>>;
}

export class KmsEcdsaSigner implements AttestationSigner {
  readonly keyId: string;
  private readonly kms: KmsSendLike;

  constructor(input: { kms: KmsSendLike; keyId: string }) {
    this.kms = input.kms;
    this.keyId = input.keyId;
  }

  async sign(message: Buffer): Promise<Buffer> {
    const out = await this.kms.send({
      name: 'SignCommand',
      input: { KeyId: this.keyId, Message: message, MessageType: 'RAW', SigningAlgorithm: 'ECDSA_SHA_256' },
    });
    const sig = out.Signature;
    if (!sig || !(sig instanceof Uint8Array) || sig.length === 0) throw new Error('KMS returned no signature');
    return Buffer.from(sig);
  }

  /** Fetches and checks the public key. Refuses a key that is not P-256 signing. */
  async publicKeyPem(): Promise<string> {
    const out = await this.kms.send({ name: 'GetPublicKeyCommand', input: { KeyId: this.keyId } });
    if (out.KeySpec !== 'ECC_NIST_P256') throw new Error(`KMS key spec is ${String(out.KeySpec)}, not ECC_NIST_P256`);
    if (out.KeyUsage !== 'SIGN_VERIFY') throw new Error(`KMS key usage is ${String(out.KeyUsage)}, not SIGN_VERIFY`);
    const der = out.PublicKey;
    if (!(der instanceof Uint8Array) || der.length === 0) throw new Error('KMS returned no public key');
    return createPublicKey({ key: Buffer.from(der), format: 'der', type: 'spki' }).export({ type: 'spki', format: 'pem' }).toString();
  }
}
