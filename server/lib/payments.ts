/**
 * PLATFORM-MANAGED FILE — DO NOT EDIT OR DELETE.
 * The platform overwrites this file on every run; local changes are lost.
 *
 * Payments for your server. Two jobs:
 *
 * 1. EVERY app that sells anything imports this file in server/index.ts, as
 *    its first line:
 *
 *      import './lib/payments.js';
 *
 *    That is all. Importing it makes this server answer /api/_payments/*
 *    (what the app's purchase(), getProducts() and hasEntitlement() call)
 *    BEFORE any route or middleware of yours runs — your auth, routers and
 *    catch-alls never see those requests, and nothing else is touched. Keep
 *    the plain import: a named import that is never used is dropped by the
 *    compiler, and then nothing answers. (An explicit
 *    handlePaymentsRequest(req, res) call still works, and is harmless.)
 *
 * 2. A CART or ORDER, whose amount only your server knows:
 *      import { createPayment, finalizePayment } from './lib/payments.js';
 *
 * The order flow, and why it has two halves:
 *
 *   1. Your server works out what the order costs and calls createPayment().
 *      You get back a URL. Send the browser there.
 *   2. The user pays and comes straight back to YOUR site — they never see
 *      any other domain in between.
 *   3. Your return page asks your server to confirm, and your server calls
 *      finalizePayment(orderRef). ONLY THEN is the money actually taken, and
 *      only then should you mark the order paid.
 *
 * Step 3 is not a formality. Until it runs, the money is merely held: if the
 * user closes the tab, or your stock check fails, or your server never hears
 * about it, the full amount is returned to them automatically. So:
 *
 *   - NEVER treat the user landing back on your site as proof of payment.
 *     Anyone can type that URL. Ask finalizePayment() and believe only that.
 *   - Do the parts of the order that must not happen without money (reserving
 *     stock, sending the goods) AFTER finalizePayment() says approved.
 *
 * While the app is in test mode, all of this runs for real against a test
 * payment page and no money moves. When the owner enters their real payment details
 * in the panel, this same code starts taking real money — no edits, no redeploy.
 */

import { Server, type IncomingMessage, type ServerResponse } from 'node:http';

const BASE = process.env.PLATFORM_SERVICES_URL;
const TOKEN = process.env.PLATFORM_SERVICE_TOKEN;

export type PaymentMode = 'sandbox' | 'live';

export interface CreatePaymentInput {
  /** What to charge, in TOMAN (not rial). Must be a whole number. */
  amountToman: number;
  /** Your own order id. One payment per order id — reusing one is rejected. */
  orderRef: string;
  /**
   * Where on YOUR site the user comes back to. Put your order reference in it
   * yourself, e.g. 'https://shop.example.com/checkout/done?order=' + orderRef,
   * so the return page knows which order to confirm.
   */
  returnUrl: string;
  /** Optional: whoever is paying, in your own terms (a user id, a phone). */
  endUserRef?: string;
  /** Optional: a short label, shown only in the owner's payments list. */
  description?: string;
}

export interface CreatePaymentResult {
  /** Send the browser here. */
  redirectUrl: string;
  paymentId: string;
  mode: PaymentMode;
}

export interface FinalizeResult {
  /** true means the money is now actually captured. Nothing else means that. */
  approved: boolean;
  orderId: string;
  /** What was actually charged. Check it against your own order total. */
  amountToman: number;
  state: 'pending' | 'paid' | 'failed' | 'refunded' | string;
  /** Why it wasn't approved, in plain terms. */
  reason?: string;
  /** The catalog product this paid for (null for an amount you created). */
  productId?: string | null;
  /** 'sandbox' (test, no money moved) or 'live'. */
  mode?: PaymentMode;
  /** 'bazaarpay' (website) or 'iap' (Android app). */
  channel?: string;
  /** When the money was taken (ISO string), or null while it is not. */
  paidAt?: string | null;
}

/** False when the project has no payments configured — check before offering checkout. */
export function isPaymentsConfigured(): boolean {
  return !!BASE && !!TOKEN;
}

async function api(path: string, body?: unknown): Promise<any> {
  if (!isPaymentsConfigured()) {
    throw new Error('Payments are not configured for this project.');
  }
  const res = await fetch(BASE + '/payments' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + TOKEN,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data?.error || 'Payment request failed (' + res.status + ')') as Error & { status?: number };
    error.status = res.status;
    throw error;
  }
  return data;
}

/**
 * Start a payment for an amount you worked out yourself.
 *
 * Nothing is charged yet — this only opens the checkout. Store the orderRef
 * against your order row before redirecting, so the return page can find it.
 */
export async function createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
  return api('/orders', {
    amountToman: Math.round(input.amountToman),
    orderId: input.orderRef,
    returnUrl: input.returnUrl,
    endUserRef: input.endUserRef,
    description: input.description,
  });
}

/**
 * Capture the money for an order. Call it when the user comes back and you are
 * ready to fulfil the order; complete the order only if it returns approved.
 *
 * Safe to call more than once — an order already captured answers approved
 * again without charging twice, so retrying after a timeout is always correct.
 *
 * Throws (rather than returning approved:false) when we could not get an
 * answer from the gateway at all. That is a "try again", NOT a "they didn't
 * pay": cancelling the order there could throw away a real payment.
 */
export async function finalizePayment(orderRef: string): Promise<FinalizeResult> {
  return api('/orders/finalize', { orderId: orderRef });
}

export interface PaymentRecord {
  orderId: string;
  amountToman: number;
  state: 'pending' | 'paid' | 'failed' | 'refunded' | string;
  channel: string;
  mode: PaymentMode;
  productId: string | null;
  endUserRef: string | null;
  description: string | null;
  createdAt: string;
  paidAt: string | null;
}

/**
 * Payment history for this app — amount, order reference, status, when.
 *
 * Use it to build an admin/sales page inside YOUR app. It deliberately holds
 * no order detail (no items, no addresses, no customer names): that is your
 * data, in your own database. Join on orderId to show the full picture.
 */
export async function listPayments(
  options: { limit?: number; offset?: number; state?: string } = {},
): Promise<PaymentRecord[]> {
  const q = new URLSearchParams();
  if (options.limit) q.set('limit', String(options.limit));
  if (options.offset) q.set('offset', String(options.offset));
  if (options.state) q.set('state', options.state);
  const data = await api('/orders' + (q.toString() ? '?' + q.toString() : ''));
  return data.payments || [];
}

// ── Relay for the app's own frontend (src/lib/payments.ts) ──────────────────

/**
 * The only routes the browser may reach, and the method each takes. Every one
 * of them names WHAT to buy, never how much — the platform prices it from the
 * catalog. Amount-taking calls (createPayment, finalizePayment, listPayments)
 * are deliberately absent: those are your server's calls, never the browser's.
 */
const RELAYED: Record<string, 'GET' | 'POST'> = {
  products: 'GET',
  checkout: 'POST',
  entitlements: 'GET',
  'iap/verify': 'POST',
};

const MAX_RELAY_BODY_BYTES = 64 * 1024;

/** How long one relayed call may take. iap/verify asks the store itself. */
const RELAY_TIMEOUT_MS = 30_000;

type RelayBody = { ok: true; text: string } | { ok: false; status: 400 | 413; error: string };

function readRelayBody(req: IncomingMessage): Promise<RelayBody> {
  // A body parser mounted ahead of the relay has already drained the stream —
  // use what it left, in whatever shape it left it.
  const parsed = (req as IncomingMessage & { body?: unknown }).body;
  if (typeof parsed === 'string') return Promise.resolve({ ok: true, text: parsed });
  if (Buffer.isBuffer(parsed)) return Promise.resolve({ ok: true, text: parsed.toString('utf8') });
  if (parsed !== undefined && parsed !== null && typeof parsed === 'object') {
    return Promise.resolve({ ok: true, text: JSON.stringify(parsed) });
  }
  // Drained by something that left nothing usable: 'end' has already fired
  // and never fires again, so waiting for it would hang the purchase.
  if (req.readableEnded || req.complete) {
    return Promise.resolve({ ok: false, status: 400, error: 'request body was already read by another middleware' });
  }
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const settle = (result: RelayBody) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk: Buffer) => {
      // Past the cap: keep draining (so the 413 can still be written on this
      // socket) but keep nothing.
      if (settled) return;
      size += chunk.length;
      if (size > MAX_RELAY_BODY_BYTES) {
        chunks.length = 0;
        settle({ ok: false, status: 413, error: 'request too large' });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => settle({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => settle({ ok: false, status: 400, error: 'request body could not be read' }));
  });
}

/**
 * Every reply the relay writes is stamped, so the browser can tell whose
 * answer it is: '1' = the platform's own, forwarded; 'local' = the relay's.
 * No stamp means the relay never saw the request. The browser forgets a paid
 * purchase only on a stamped '1' that the platform marked final.
 */
const RELAY_HEADER = 'X-Payments-Relay';

function sendJson(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', [RELAY_HEADER]: 'local', ...extra });
  res.end(JSON.stringify(body));
}

/**
 * Handle one request if it targets /api/_payments/*. Returns true when the
 * response was written (stop routing), false when the request is not ours.
 */
export async function handlePaymentsRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  // originalUrl first: inside an Express router mounted at /api, req.url has
  // the prefix stripped ('/_payments/products') and would never match.
  // Plain node:http has no originalUrl.
  const rawUrl = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '';
  if (!rawUrl.startsWith('/api/_payments/')) return false;

  try {
    const url = new URL(rawUrl, 'http://localhost');
    const route = url.pathname.slice('/api/_payments/'.length).replace(/\/+$/, '');
    const method = (req.method ?? 'GET').toUpperCase();
    const allowed = RELAYED[route];
    if (!allowed) return sendJson(res, 404, { error: 'not found' }), true;
    if (method !== allowed) return sendJson(res, 405, { error: 'method not allowed' }), true;
    if (!isPaymentsConfigured()) {
      return sendJson(res, 503, { error: 'Payments are not configured for this project.' }), true;
    }

    let body: string | undefined;
    if (method === 'POST') {
      const read = await readRelayBody(req);
      if (!read.ok) {
        return sendJson(res, read.status, { error: read.error }, read.status === 413 ? { Connection: 'close' } : {}), true;
      }
      body = read.text || '{}';
    }

    const upstream = await fetch(BASE + '/payments/' + route + url.search, {
      method,
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
      body,
      // Covers reading the reply too. A timeout is a 504: the purchase is
      // kept and retried, and verify is idempotent per order id.
      signal: AbortSignal.timeout(RELAY_TIMEOUT_MS),
    });
    const text = await upstream.text();
    res.writeHead(upstream.status, { 'Content-Type': 'application/json; charset=utf-8', [RELAY_HEADER]: '1' });
    res.end(text || '{}');
    return true;
  } catch (err) {
    console.error('[payments] relay failed for', rawUrl, err);
    const timedOut = (err as { name?: string } | null)?.name === 'TimeoutError';
    if (!res.headersSent) {
      sendJson(res, timedOut ? 504 : 502, {
        error: timedOut
          ? 'Payment service did not answer in time. Please try again.'
          : 'Payment service unreachable. Please try again.',
      });
    }
    return true;
  }
}

// ── The relay runs first, whatever order the app's own code is in ─────────
//
// Importing this file is enough: every HTTP server in this process hands
// /api/_payments/* to the relay before its own handler — Express, a router,
// auth middleware or a catch-all never see those requests. Every other
// request reaches the app exactly as before. Installed once per process.
const RELAY_HOOK = Symbol.for('platform.payments.relayHook');
const hookHost = globalThis as typeof globalThis & { [RELAY_HOOK]?: true };
if (!hookHost[RELAY_HOOK] && typeof Server === 'function') {
  hookHost[RELAY_HOOK] = true;
  const emit = Server.prototype.emit;
  Server.prototype.emit = function (this: Server, event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'request') {
      const req = args[0] as IncomingMessage;
      if ((req.url ?? '').startsWith('/api/_payments/')) {
        handlePaymentsRequest(req, args[1] as ServerResponse).catch((err) => {
          console.error('[payments] relay failed', err);
        });
        return true;
      }
    }
    return emit.call(this, event, ...args);
  } as typeof Server.prototype.emit;
}
