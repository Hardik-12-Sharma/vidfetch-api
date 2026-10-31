import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PremiumService, type PremiumOptions } from '../src/services/premium.service.js';

const KEY_ID = 'rzp_test_AbCdEfGh123', KEY_SECRET = 'test_secret_value', TOKEN_SECRET = 'x'.repeat(40);
const sign = (o: string, p: string, secret = KEY_SECRET) => createHmac('sha256', secret).update(`${o}|${p}`).digest('hex');
const make = (extra: Partial<PremiumOptions> = {}, t = { now: 1_700_000_000 }) => ({
  t, svc: new PremiumService({ keyId: KEY_ID, keySecret: KEY_SECRET, tokenSecret: TOKEN_SECRET, pricePaise: 1900, days: 30, now: () => t.now, ...extra }),
});

describe('signature verification', () => {
  it('accepts the Razorpay HMAC and rejects anything else', () => {
    const { svc } = make();
    expect(svc.verifySignature('order_ABC123', 'pay_XYZ789', sign('order_ABC123', 'pay_XYZ789'))).toBe(true);
    expect(svc.verifySignature('order_ABC123', 'pay_XYZ789', sign('order_ABC123', 'pay_OTHER1'))).toBe(false);   // different payment
    expect(svc.verifySignature('order_ABC123', 'pay_XYZ789', sign('order_ABC123', 'pay_XYZ789', 'wrong_secret'))).toBe(false);
    expect(svc.verifySignature('order_ABC123', 'pay_XYZ789', 'zz'.repeat(32))).toBe(false);
    expect(svc.verifySignature('bad id!', 'pay_XYZ789', sign('bad id!', 'pay_XYZ789'))).toBe(false);
  });
});

describe('verifyAndIssue', () => {

  it('rejects verification when Razorpay is not configured', async () => {
    const { svc } = make({
      keyId: 'rzp_test_xxxxxxxx',
      keySecret: 'change_me',
    });

    // Even a correctly calculated signature using the placeholder
    // secret must not be accepted.
    const forgedSignature = sign(
      'order_ABC123',
      'pay_XYZ789',
      'change_me'
    );

    await expect(
      svc.verifyAndIssue('order_ABC123', 'pay_XYZ789', forgedSignature)
    ).rejects.toThrow('Payments are not configured on this server.');

    expect(
      svc.verifySignature('order_ABC123', 'pay_XYZ789', forgedSignature)
    ).toBe(false);
  });

  it('issues a token valid for `days`', async () => {
    const { svc, t } = make();
    const r = await svc.verifyAndIssue('order_ABC123', 'pay_XYZ789', sign('order_ABC123', 'pay_XYZ789'));
    expect(r.expiresAt).toBe(t.now + 30 * 86400);
    expect(svc.validUntil(r.token)).toBe(r.expiresAt);
    expect(svc.isValid(r.token)).toBe(true);
  });
  it('rejects bad signatures and malformed input with 400', async () => {
    const { svc } = make();
    await expect(svc.verifyAndIssue('order_ABC123', 'pay_XYZ789', sign('order_ABC123', 'pay_NOPE00'))).rejects.toThrow('Payment verification failed.');
    await expect(svc.verifyAndIssue(undefined, 'pay_XYZ789', 'a'.repeat(64))).rejects.toThrow('Invalid payment details.');
    await expect(svc.verifyAndIssue('order_ABC123', 'pay_XYZ789', 'short')).rejects.toThrow('Invalid payment details.');
  });
  it('one payment grants one period: re-verifying does not extend, and an ended period stays ended', async () => {
    const { svc, t } = make();
    const sig = sign('order_ABC123', 'pay_XYZ789');
    const a = await svc.verifyAndIssue('order_ABC123', 'pay_XYZ789', sig);
    t.now += 10 * 86400;
    const b = await svc.verifyAndIssue('order_ABC123', 'pay_XYZ789', sig);
    expect(b.expiresAt).toBe(a.expiresAt);
    t.now += 25 * 86400;
    await expect(svc.verifyAndIssue('order_ABC123', 'pay_XYZ789', sig)).rejects.toThrow('already ended');
  });
  it('remembers redeemed payments across restarts (no replay for a fresh period)', async () => {
    const storePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'vf-prem-')), 'p.json');
    const t = { now: 1_700_000_000 };
    const one = make({ storePath }, t).svc; await one.init();
    const sig = sign('order_ABC123', 'pay_XYZ789');
    const first = await one.verifyAndIssue('order_ABC123', 'pay_XYZ789', sig);
    t.now += 31 * 86400;
    const two = make({ storePath }, t).svc; await two.init();             // "restart"
    await expect(two.verifyAndIssue('order_ABC123', 'pay_XYZ789', sig)).rejects.toThrow('already ended');
    expect(first.expiresAt).toBeLessThan(t.now);
  });
});

describe('tokens', () => {
  it('rejects tampered, foreign-secret, expired and garbage tokens', async () => {
    const { svc, t } = make();
    const { token } = await svc.verifyAndIssue('order_ABC123', 'pay_XYZ789', sign('order_ABC123', 'pay_XYZ789'));
    const [p, s] = token.split('.');
    const forgedPayload = Buffer.from(`${t.now + 999999999}.pay_XYZ789`).toString('base64url');
    expect(svc.isValid(`${forgedPayload}.${s}`)).toBe(false);
    expect(make({ tokenSecret: 'y'.repeat(40) }).svc.isValid(token)).toBe(false);
    for (const bad of ['', 'abc', 'a.b.c', `${p}.`, undefined, null, 'x'.repeat(301)]) expect(svc.isValid(bad as any)).toBe(false);
    t.now += 31 * 86400;
    expect(svc.isValid(token)).toBe(false);
    expect(svc.validUntil(token)).toBe(0);
  });
  it('accepts a token in the format the Java service produced', () => {
    // Java: base64url(exp + "." + paymentId) + "." + base64url(HMAC_SHA256(payload, secret)), no padding
    const { svc, t } = make();
    const payload = `${t.now + 1000}.pay_XYZ789`;
    const tok = Buffer.from(payload).toString('base64url') + '.' + createHmac('sha256', TOKEN_SECRET).update(payload).digest('base64url');
    expect(svc.validUntil(tok)).toBe(t.now + 1000);
  });
});

describe('createOrder (Razorpay API mocked)', () => {
  it('uses the server-side price and never the client', async () => {
    let seen: any;
    const fetchImpl = (async (url: string, init: any) => {
      seen = { url, init, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ id: 'order_NEW123', amount: 1900, currency: 'INR' }), { status: 200 });
    }) as unknown as typeof fetch;
    const { svc } = make({ fetchImpl });
    const r = await svc.createOrder();
    expect(r).toEqual({ success: true, orderId: 'order_NEW123', amount: 1900, currency: 'INR', keyId: KEY_ID });
    expect(seen.url).toBe('https://api.razorpay.com/v1/orders');
    expect(seen.body.amount).toBe(1900); expect(seen.body.currency).toBe('INR'); expect(seen.body.receipt).toMatch(/^rcpt_/);
    expect(seen.init.headers.Authorization).toBe('Basic ' + Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64'));
    expect(JSON.stringify(r)).not.toContain(KEY_SECRET);                      // secret never leaves the server
  });
  it('maps Razorpay failures to 502 and unconfigured keys to 503', async () => {
    const fail = (async () => new Response('{}', { status: 400 })) as unknown as typeof fetch;
    await expect(make({ fetchImpl: fail }).svc.createOrder()).rejects.toThrow('Could not start payment');
    const net = (async () => { throw new Error('boom'); }) as unknown as typeof fetch;
    await expect(make({ fetchImpl: net }).svc.createOrder()).rejects.toThrow('Could not start payment');
    await expect(make({ keyId: 'rzp_test_xxxxxxxx', keySecret: 'change_me' }).svc.createOrder()).rejects.toThrow('not configured');
  });
});
