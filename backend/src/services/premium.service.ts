import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ApiError } from '../utils/apiError.js';

export interface PremiumOptions {
  keyId: string;
  keySecret: string;
  tokenSecret: string;
  pricePaise: number;
  days: number;
  /** JSON file remembering which payments were already redeemed (survives restarts). Omit for in-memory only. */
  storePath?: string;
  fetchImpl?: typeof fetch;
  now?: () => number; // epoch seconds
}

const ID = /^[A-Za-z0-9_]{5,64}$/;
const HEX64 = /^[a-fA-F0-9]{64}$/;
const b64u = (b: Buffer | string) => Buffer.from(b).toString('base64url');
const hmac = (data: string, secret: string) => createHmac('sha256', secret).update(data, 'utf8').digest();
const safeEq = (a: Buffer, b: Buffer) => a.length === b.length && timingSafeEqual(a, b);

/** Razorpay order creation, signature verification, and signed premium tokens (token format unchanged from the Java service). */
export class PremiumService {
  private paid = new Map<string, number>(); // paymentId -> expiry (epoch s). Kept forever so a replayed payment can't be re-redeemed.
  private writeChain: Promise<void> = Promise.resolve();
  private f: typeof fetch;
  private now: () => number;

  constructor(private o: PremiumOptions) {
    this.f = o.fetchImpl ?? fetch;
    this.now = o.now ?? (() => Math.floor(Date.now() / 1000));
  }

  async init() {
    if (!this.o.storePath) return;
    await fs.mkdir(path.dirname(this.o.storePath), { recursive: true });
    try {
      const data = JSON.parse(await fs.readFile(this.o.storePath, 'utf8')) as Record<string, number>;
      for (const [k, v] of Object.entries(data)) if (ID.test(k) && Number.isFinite(v)) this.paid.set(k, v);
    } catch { /* first run */ }
  }
  private persist(): Promise<void> {
    const file = this.o.storePath;
    if (!file) return Promise.resolve();
    const snapshot = JSON.stringify(Object.fromEntries(this.paid));
    this.writeChain = this.writeChain.then(async () => {
      const tmp = `${file}.${process.pid}.tmp`;
      await fs.writeFile(tmp, snapshot, { mode: 0o600 });
      await fs.rename(tmp, file);
    }).catch(() => undefined);
    return this.writeChain;
  }

  get configured() { return !/^rzp_test_x+$/i.test(this.o.keyId) && this.o.keySecret !== 'change_me' && this.o.keyId.length > 8; }

  /** Price always comes from server config; the client cannot influence amount or currency. */
  async createOrder() {
    if (!this.configured) throw new ApiError(503, 'Payments are not configured on this server.');
    let res: Response;
    try {
      res = await this.f('https://api.razorpay.com/v1/orders', {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${this.o.keyId}:${this.o.keySecret}`).toString('base64'),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ amount: this.o.pricePaise, currency: 'INR', receipt: 'rcpt_' + randomUUID().slice(0, 12) }),
      });
    } catch { throw new ApiError(502, 'Could not start payment. Please try again.'); }
    if (res.status !== 200) throw new ApiError(502, 'Could not start payment. Please try again.');
    const j = (await res.json().catch(() => ({}))) as { id?: string; amount?: number; currency?: string };
    if (!j.id) throw new ApiError(502, 'Could not start payment. Please try again.');
    return { success: true as const, orderId: j.id, amount: j.amount ?? this.o.pricePaise, currency: j.currency ?? 'INR', keyId: this.o.keyId };
  }

  /** Razorpay's documented check: HMAC-SHA256(order_id + "|" + payment_id, key_secret) must equal the signature. */
  verifySignature(orderId: string, paymentId: string, signature: string): boolean {
    if (!this.configured) return false;

    if (!ID.test(orderId) || !ID.test(paymentId) || !HEX64.test(signature)) return false;

    return safeEq(
      hmac(`${orderId}|${paymentId}`, this.o.keySecret),
      Buffer.from(signature, 'hex')
    );
  }

  async verifyAndIssue(orderId: string | undefined, paymentId: string | undefined, signature: string | undefined) {
    if (!this.configured) {
      throw new ApiError(503, 'Payments are not configured on this server.');
    }
    if (!orderId || !paymentId || !signature || !ID.test(orderId) || !ID.test(paymentId) || !HEX64.test(signature)) {
      throw new ApiError(400, 'Invalid payment details.');
    }
    if (!this.verifySignature(orderId, paymentId, signature)) throw new ApiError(400, 'Payment verification failed.');
    const now = this.now();
    let exp = this.paid.get(paymentId);
    if (exp === undefined) { exp = now + this.o.days * 86400; this.paid.set(paymentId, exp); await this.persist(); }
    if (exp <= now) throw new ApiError(400, 'This premium period has already ended.');
    return { success: true as const, token: this.makeToken(exp, paymentId), expiresAt: exp };
  }

  isValid(token: string | undefined | null) { return this.validUntil(token) > 0; }

  /** Expiry (epoch seconds) of a valid, unexpired token; otherwise 0. */
  validUntil(token: string | undefined | null): number {
    try {
      if (!token || token.length > 300) return 0;
      const parts = token.split('.');
      if (parts.length !== 2) return 0;
      const payload = Buffer.from(parts[0]!, 'base64url').toString('utf8');
      if (!safeEq(hmac(payload, this.o.tokenSecret), Buffer.from(parts[1]!, 'base64url'))) return 0;
      const exp = Number(payload.slice(0, payload.indexOf('.')));
      return Number.isInteger(exp) && exp > this.now() ? exp : 0;
    } catch { return 0; }
  }

  private makeToken(exp: number, paymentId: string) {
    const payload = `${exp}.${paymentId}`;
    return `${b64u(payload)}.${b64u(hmac(payload, this.o.tokenSecret))}`;
  }
}
