import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';
import { canonicalJson } from '../util/canonical.js';
import type { MandateBody, SignedMandate } from '../domain/schemas.js';

/**
 * Signs and verifies mandates with Ed25519. A mandate that was edited after
 * signing (a raised limit, a removed category block) fails verification and
 * the policy engine refuses to act on it.
 *
 * MVP note: the gateway holds the key. In a production design the *user's*
 * device or PayPal-side identity would sign, so even a compromised gateway
 * could not mint authority.
 */
export class MandateSigner {
  private readonly privateKey: KeyObject;
  private readonly publicKey: KeyObject;
  readonly keyId: string;

  constructor(privateKeyPem?: string) {
    if (privateKeyPem) {
      this.privateKey = createPrivateKey(privateKeyPem);
      this.publicKey = createPublicKey(this.privateKey);
    } else {
      const pair = generateKeyPairSync('ed25519');
      this.privateKey = pair.privateKey;
      this.publicKey = pair.publicKey;
    }
    const der = this.publicKey.export({ type: 'spki', format: 'der' });
    this.keyId = createHash('sha256').update(der).digest('hex').slice(0, 16);
  }

  sign(body: MandateBody): SignedMandate {
    const signature = edSign(null, Buffer.from(canonicalJson(body)), this.privateKey).toString('base64');
    return { body, signature, keyId: this.keyId };
  }

  verify(mandate: SignedMandate): boolean {
    if (mandate.keyId !== this.keyId) return false;
    try {
      return edVerify(
        null,
        Buffer.from(canonicalJson(mandate.body)),
        this.publicKey,
        Buffer.from(mandate.signature, 'base64'),
      );
    } catch {
      return false;
    }
  }
}
