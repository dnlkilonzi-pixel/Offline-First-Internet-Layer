'use strict';

/**
 * identity.js – Node identity using Ed25519 key pairs.
 *
 * Each node generates a persistent Ed25519 keypair on first start and stores
 * it in a local JSON file.  Outgoing messages are signed; incoming messages
 * can be verified against the sender's advertised public key.
 *
 * Public keys are 32-byte Ed25519 raw keys represented as 64-char hex strings.
 * Signatures are 64-byte Ed25519 signatures represented as 128-char hex strings.
 *
 * Signed fields (canonical order, always the same set):
 *   id, content, sender, type, timestamp, lamport
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class Identity {
  /**
   * @param {string} [keyFilePath] – Path to the JSON file holding the keypair.
   *   Defaults to `data/identity.json` relative to the project root.
   */
  constructor(keyFilePath) {
    this._keyFile = keyFilePath || path.join(__dirname, '..', 'data', 'identity.json');
    this._privateKey = null;
    this._publicKey = null;
    this._publicKeyHex = null;
    this._load();
  }

  // ── Private ───────────────────────────────────────────────────────────────

  _load() {
    try {
      if (fs.existsSync(this._keyFile)) {
        const data = JSON.parse(fs.readFileSync(this._keyFile, 'utf8'));
        this._privateKey = crypto.createPrivateKey({ key: data.privateKey, format: 'pem' });
        this._publicKey = Identity._pubKeyFromHex(data.publicKeyHex);
        this._publicKeyHex = data.publicKeyHex;
        return;
      }
    } catch (_) {
      // Fall through to generate a fresh keypair.
    }
    this._generate();
  }

  _generate() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const jwk = publicKey.export({ format: 'jwk' });
    const publicKeyHex = Buffer.from(jwk.x, 'base64url').toString('hex');

    this._privateKey = privateKey;
    this._publicKey = publicKey;
    this._publicKeyHex = publicKeyHex;

    const dir = path.dirname(this._keyFile);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      this._keyFile,
      JSON.stringify({
        privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
        publicKeyHex,
      }),
      'utf8'
    );
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /** This node's public key as a 64-char hex string. */
  get publicKeyHex() {
    return this._publicKeyHex;
  }

  /**
   * Sign the canonical fields of a message.
   * @param {{ id: string, content: string, sender: string, type: string, timestamp: string, lamport?: number }} fields
   * @returns {string} Hex-encoded Ed25519 signature (128 chars).
   */
  sign(fields) {
    const payload = Buffer.from(Identity._canonicalize(fields));
    return crypto.sign(null, payload, this._privateKey).toString('hex');
  }

  /**
   * Verify a message signature.
   * Returns false (not throws) on any error so callers can handle gracefully.
   *
   * @param {{ id, content, sender, type, timestamp, lamport }} fields
   * @param {string} sigHex
   * @param {string} pubKeyHex
   * @returns {boolean}
   */
  static verify(fields, sigHex, pubKeyHex) {
    try {
      const pubKey = Identity._pubKeyFromHex(pubKeyHex);
      const payload = Buffer.from(Identity._canonicalize(fields));
      const sig = Buffer.from(sigHex, 'hex');
      return crypto.verify(null, payload, pubKey, sig);
    } catch (_) {
      return false;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Stable JSON serialization of the fields that are included in the signature.
   * The key order is fixed so that sign and verify always hash the same bytes.
   */
  static _canonicalize({ id, content, sender, type, timestamp, lamport }) {
    return JSON.stringify({ id, content, sender, type, timestamp, lamport: lamport || 0 });
  }

  /**
   * Reconstruct a Node.js CryptoKey from a 32-byte raw public key in hex.
   * Ed25519 public keys are imported via JWK so no manual DER is needed.
   */
  static _pubKeyFromHex(hex) {
    const x = Buffer.from(hex, 'hex').toString('base64url');
    return crypto.createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
  }
}

module.exports = Identity;
