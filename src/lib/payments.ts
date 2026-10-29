/**
 * Payments — provided by the platform. Do not edit; changes are overwritten.
 *
 * One call works everywhere: on the website it opens the payment gateway, in
 * the Android app it opens the in-app purchase flow. You never choose, and you
 * never handle credentials — the platform resolves both per call.
 *
 * It talks to YOUR server, not to the platform: the first line of
 * server/index.ts must be  import './lib/payments.js';
 *
 * While the app is in test mode no money moves, and the purchase sheet says so
 * where it matters. When the owner enters their real payment details in the
 * panel, the very same code starts taking real money — no edits, no rebuild.
 *
 * FIXED-PRICE things you sell (coins, pro, remove-ads) — declare them in
 * src/products.ts and use:
 *
 *   const products = await getProducts();
 *   await purchase('coins_100', { endUserRef: userId });
 *   if (await hasEntitlement('remove_ads', userId)) { ... }
 *
 * A CART or ORDER, whose price only exists once the order does — the amount
 * must come from your server, never from here. Your server calls
 * createPayment() (server/lib/payments.ts) and hands back a URL; this side
 * only opens it:
 *
 *   const { redirectUrl } = await fetch('/api/checkout', ...).then(r => r.json());
 *   await openCheckout(redirectUrl);          // works on web AND in the app
 *   // then ask YOUR server whether the order is paid — never the URL
 */

// The app's own server relays these (server/lib/payments.ts). Relative on
// purpose: never an absolute URL, never a token.
const BASE = '/api/_payments';

export type ProductKind = 'consumable' | 'non_consumable' | 'subscription';
export type PaymentMode = 'sandbox' | 'live';

export interface Product {
  productId: string;
  title: string;
  priceToman: number;
  kind: ProductKind;
  /** The product's code on Bazaar, when the owner set one. Used by purchase() — never needed in your code. */
  bazaarSku?: string | null;
}

export interface PurchaseResult {
  /** true once the platform has verified the money (or simulated it in test mode). */
  success: boolean;
  /** Set when the user closed the purchase sheet without paying. */
  cancelled?: boolean;
  /**
   * Set when the purchase was stopped BEFORE any payment page or store sheet
   * opened (the website checkout was refused, in-app billing is unavailable,
   * the item is not on sale): nothing can have been paid. Without it, an error
   * may have come after the money moved and must be treated as maybe-paid.
   */
  refused?: boolean;
  orderId?: string;
  error?: string;
}

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(BASE + path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Who answered decides what the answer means. The relay stamps every reply
    // it writes: '1' when it forwarded the platform's own answer, 'local' when
    // it answered itself. No stamp means the relay never saw the request —
    // the server never loads server/lib/payments.ts, or there is no server.
    const relay = res.headers.get('X-Payments-Relay');
    const error = new Error(
      relay
        ? body?.error || 'Payment request failed (' + res.status + ')'
        : "Payments are not connected: the first line of server/index.ts must be import './lib/payments.js';",
    ) as Error & { status?: number; final?: boolean };
    error.status = res.status;
    // Recovery may forget a pending purchase ONLY on this: the platform's own
    // verdict that this purchase will never be accepted. Every other failure,
    // 4xx included (a 401 from auth middleware, a rate limit, a product the
    // owner switched off after the buyer paid), says nothing about the
    // purchase — and the buyer may already have paid.
    error.final = relay === '1' && body?.final === true;
    throw error;
  }
  return body;
}

/** True inside the Android app, false on the website. Decides which channel runs. */
function isNativeApp(): boolean {
  const cap = (globalThis as any).Capacitor;
  return !!cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform();
}

const pluginCache: Record<string, any> = {};

/**
 * Get a native Capacitor plugin by its registered name.
 *
 * ⚠️ Capacitor.Plugins[name] is NOT pre-populated. Android's bridge injects
 * only Capacitor.PluginHeaders; the per-plugin proxy is built by
 * registerPlugin(), which normally runs when the page imports the plugin's own
 * JS module. This file deliberately imports nothing (it has to compile in a
 * plain web build too), so we ask the bridge to build the proxy instead.
 * Reading Capacitor.Plugins[name] alone returns undefined and every payment
 * silently falls back to the web path.
 *
 * isPluginAvailable first: it consults PluginHeaders, i.e. "was this plugin
 * compiled into the running binary" — without it registerPlugin hands back a
 * proxy whose every call rejects with UNIMPLEMENTED.
 */
function capPlugin(name: string): any {
  if (name in pluginCache) return pluginCache[name];
  const cap = (globalThis as any).Capacitor;
  const available = typeof cap?.isPluginAvailable === 'function' && cap.isPluginAvailable(name);
  pluginCache[name] = available ? (cap.Plugins?.[name] ?? cap.registerPlugin?.(name)) : undefined;
  return pluginCache[name];
}

/**
 * The in-app billing plugin, registered natively as "CapacitorPoolakey".
 * NOT "Poolakey" — that is only a JS-side wrapper class in the plugin's own
 * bundle, which we never load.
 */
function iapPlugin(): any {
  return capPlugin('CapacitorPoolakey');
}

let iapConnecting: Promise<boolean> | null = null;

/**
 * Bind to Bazaar's billing service. **Required before any purchase** — the
 * plugin rejects purchaseProduct outright with "Payment is not connected"
 * unless a live connection exists.
 *
 * No RSA public key is passed, which turns off the plugin's on-device receipt
 * signature check (SecurityCheck.Disable). That check is a convenience, not
 * the guarantee: what decides whether a purchase is real is the platform's
 * server-side validation against Bazaar's developer API, which runs on every
 * purchase regardless and cannot be influenced from the device.
 *
 * Concurrent callers share one attempt; a failed one isn't cached, so the next
 * purchase retries instead of staying dead for the session.
 */
async function connectIap(): Promise<boolean> {
  if (!iapConnecting) {
    iapConnecting = (async () => {
      const plugin = iapPlugin();
      if (!plugin) return false;
      await plugin.connectPayment({});
      return true;
    })().catch(() => {
      iapConnecting = null;
      return false;
    });
  }
  return iapConnecting;
}

/** True when this page is inside someone else's frame — i.e. the builder's preview. */
function isFramed(): boolean {
  try {
    return window.self !== window.top;
  } catch {
    // Cross-origin parent: being unable to look up is itself the answer.
    return true;
  }
}

/**
 * Send the browser to a payment page.
 *
 * A real payment page cannot run inside a frame — gateways refuse to render
 * there, and a bank's 3-D Secure step would be unusable even if they didn't.
 * So from inside the builder's preview this opens a real tab, which is also
 * the honest analogue of what the installed app does (it puts a real browser
 * over itself). Everywhere else it is a plain navigation, exactly as a
 * checkout should be.
 */
function navigateToGateway(url: string): void {
  if (!isFramed()) {
    location.href = url;
    return;
  }
  // The checkout was created by an await, so the browser may no longer count
  // this as the user's click and can refuse the tab. Falling back to a button
  // they press themselves is the only thing that always works — and losing a
  // payment to a silently blocked popup is not an acceptable way to fail.
  const opened = window.open(url, '_blank', 'noopener');
  if (!opened) showGatewayLink(url);
}

/** Last resort when the browser blocked the payment tab: let the user open it. */
function showGatewayLink(url: string): void {
  const overlay = document.createElement('div');
  overlay.setAttribute('style', [
    'position:fixed', 'inset:0', 'z-index:2147483646',
    'background:rgba(0,0,0,.55)', 'display:flex',
    'align-items:center', 'justify-content:center', 'padding:20px',
    'font-family:Vazirmatn,system-ui,sans-serif', 'direction:rtl',
  ].join(';'));

  const card = document.createElement('div');
  card.setAttribute('style', [
    'background:#fff', 'color:#111', 'border-radius:14px', 'padding:20px',
    'max-width:360px', 'text-align:center',
  ].join(';'));
  card.innerHTML =
    '<div style="font-size:14px;margin-bottom:14px;line-height:1.7">' +
      'برای ادامه پرداخت، صفحه درگاه باید در یک زبانه جدید باز شود.' +
    '</div>';

  const link = document.createElement('a');
  link.href = url;
  link.target = '_blank';
  link.rel = 'noopener';
  link.textContent = 'رفتن به درگاه پرداخت';
  link.setAttribute('style', [
    'display:inline-block', 'padding:10px 18px', 'border-radius:10px',
    'background:#16a34a', 'color:#fff', 'font-size:15px', 'text-decoration:none',
  ].join(';'));
  link.addEventListener('click', () => overlay.remove());

  card.appendChild(link);
  overlay.appendChild(card);
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  document.body.appendChild(overlay);
}

/**
 * Test-mode only: the owner can force the other channel to try both flows from
 * one device. Ignored entirely in live mode (the server decides), so an end
 * user can never steer their own purchase.
 */
const CHANNEL_OVERRIDE_KEY = 'ab_pay_channel';
function channelOverride(): 'web' | 'app' | null {
  try {
    const fromUrl = new URLSearchParams(location.search).get(CHANNEL_OVERRIDE_KEY);
    if (fromUrl === 'web' || fromUrl === 'app') {
      // Persisted because the app is a SPA and will navigate away from the URL
      // that carried the flag.
      sessionStorage.setItem(CHANNEL_OVERRIDE_KEY, fromUrl);
      return fromUrl;
    }
    const stored = sessionStorage.getItem(CHANNEL_OVERRIDE_KEY);
    return stored === 'web' || stored === 'app' ? stored : null;
  } catch {
    return null;
  }
}

let cachedMode: PaymentMode | null = null;
// Whether the platform lets this app START an in-app purchase: the owner can
// turn it off, and live it needs working keys. Read with the products.
let cachedInApp = true;
let cachedProducts: Product[] | null = null;

let recoveryStarted = false;

/**
 * The app's catalog, straight from the platform. Once per session it also
 * settles any purchase left in flight by a previous run (see
 * recoverPendingPurchases) — so a user who paid and then lost the app gets
 * what they bought without having to do anything.
 */
export async function getProducts(): Promise<Product[]> {
  const data = await api('/products');
  cachedMode = data.mode;
  cachedInApp = data.inApp !== false;

  if (!recoveryStarted) {
    recoveryStarted = true;
    // Deliberately not awaited: recovery must never delay rendering a store.
    void recoverPendingPurchases().catch(() => {});
  }

  cachedProducts = data.products || [];
  return cachedProducts as Product[];
}

/**
 * 'sandbox' until the owner enters their real payment details, 'live' after.
 *
 * Nothing is drawn on top of your app for you — if you want your own "this is
 * a test payment" note somewhere, this is how you decide whether to show it.
 * The simulated purchase sheet says so itself, and the owner sees it in their
 * payments panel, so you are not obliged to.
 */
export async function getPaymentMode(): Promise<PaymentMode> {
  if (cachedMode) return cachedMode;
  await getProducts();
  return cachedMode || 'sandbox';
}

/**
 * Send the user to a payment page your SERVER created, and come back.
 *
 * On the website this navigates away, so nothing after it runs — read the
 * outcome on the page the user returns to.
 *
 * Inside the Android app it opens a real browser over the app (the payment
 * goes through the gateway and then the user's bank, which cannot run inside
 * an app WebView) and resolves once the user is back in the app. Whether they
 * actually paid is not knowable here — ask your own server, which asks us.
 */
export async function openCheckout(redirectUrl: string): Promise<void> {
  const browser = capPlugin('Browser');

  // Deliberately NOT branched on the test-mode channel switcher: that chooses
  // between in-app purchase and the gateway, and this function is only ever
  // the gateway. In test mode the platform hands back its own test payment
  // page instead of BazaarPay's, so the same navigation works unchanged and
  // no money moves.
  if (isNativeApp() && browser?.open) {
    await browser.open({ url: redirectUrl });
    await waitForReturnToApp(browser, capPlugin('App'));
    // The user may have swiped back rather than closing the tab, leaving the
    // payment page sitting behind the app.
    try { await browser.close?.(); } catch {}
    return;
  }

  if (isFramed()) {
    // The builder's preview. Opening a tab mirrors what the installed app
    // does — a real browser over the page — and resolves when the user comes
    // back, so "check the order, then show the result" is the same code here
    // as on a device.
    navigateToGateway(redirectUrl);
    await waitForReturnToApp(null, null);
    return;
  }

  location.href = redirectUrl;
}

/**
 * Resolves when the user comes back from the payment browser.
 *
 * Two signals, because neither alone is reliable: 'browserFinished' misses the
 * user who swipes back to the app without closing the tab, and the app-state
 * signal can fire on devices where the tab is technically a separate task.
 * First one wins; listeners are always removed.
 */
function waitForReturnToApp(browser: any, app: any): Promise<void> {
  return new Promise(resolve => {
    const handles: any[] = [];
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      for (const h of handles) { try { h?.remove?.(); } catch {} }
      resolve();
    };

    // Capacitor 6 returns a Promise<PluginListenerHandle>; older shims return
    // the handle directly. Keep whichever arrives so it can be removed.
    const listen = (plugin: any, event: string, handler: (v: any) => void): boolean => {
      if (typeof plugin?.addListener !== 'function') return false;
      try {
        const h = plugin.addListener(event, handler);
        if (h && typeof h.then === 'function') h.then((x: any) => handles.push(x)).catch(() => {});
        else if (h) handles.push(h);
        return true;
      } catch {
        return false;
      }
    };

    // Registered separately so one missing plugin doesn't disable the other.
    const listening = [
      listen(browser, 'browserFinished', finish),
      listen(app, 'appStateChange', (state: any) => { if (state?.isActive) finish(); }),
    ].some(Boolean);

    // Third signal, needing no plugin at all: the WebView is hidden while the
    // payment browser is on top and visible again once it isn't. This is what
    // covers an APK built before those plugins shipped — without it, such a
    // build would wait here forever.
    try {
      const onVisible = () => { if (!document.hidden) finish(); };
      document.addEventListener('visibilitychange', onVisible);
      handles.push({ remove: () => document.removeEventListener('visibilitychange', onVisible) });
    } catch {
      if (!listening) finish();
    }
  });
}

/**
 * Buy something. Resolves once the platform has confirmed the payment.
 *
 * On the website this navigates away to the gateway and returns when the user
 * comes back, so treat anything after this call as unreachable on that path —
 * read the result from the URL on your return page (see completedPurchase()).
 *
 * Inside the builder's preview it cannot navigate away (the page is framed),
 * so the gateway opens in a tab and this waits for you to come back, then
 * answers from the server. Same code, same result — you just get to watch it
 * happen without leaving the editor.
 */
export async function purchase(
  productId: string,
  options: { orderId?: string; endUserRef?: string; returnUrl?: string } = {},
): Promise<PurchaseResult> {
  const orderId = options.orderId || generateOrderId();
  const endUserRef = options.endUserRef;
  const override = channelOverride();
  const useApp = override ? override === 'app' : isNativeApp();

  try {
    if (useApp) return await purchaseInApp(productId, orderId, endUserRef);

    let redirectUrl: string;
    try {
      ({ redirectUrl } = await api('/checkout', {
        method: 'POST',
        body: JSON.stringify({
          productId,
          orderId,
          endUserRef,
          returnUrl: options.returnUrl || location.href,
        }),
      }));
    } catch (err: any) {
      // No payment page was opened (e.g. website payment is not set up for
      // this app), so nothing can have been paid.
      return { success: false, refused: true, orderId, error: err?.message || 'Payment failed' };
    }
    navigateToGateway(redirectUrl);

    if (isFramed()) {
      // The page is still here, so the caller WILL see what this returns —
      // unlike the real navigation, where nothing after it runs. Reporting
      // failure now would make every preview purchase look broken, so wait
      // for the tab to close and then ask the server what actually happened.
      await waitForReturnToApp(null, null);
      const owned = await hasEntitlement(productId, endUserRef).catch(() => false);
      return { success: owned, orderId };
    }

    return { success: false, orderId };
  } catch (err: any) {
    return { success: false, orderId, error: err?.message || 'Payment failed' };
  }
}

/**
 * Read the outcome of a website purchase after the gateway sends the user
 * back. Call this on page load of whatever you passed as returnUrl.
 *
 * ⚠️ This reads the URL, so it is a HINT ABOUT WHAT TO SHOW and nothing more —
 * the user can type '?payment_status=success' themselves. Use it to decide
 * between a thank-you and a try-again message; use hasEntitlement() to decide
 * whether they actually own the thing.
 */
export function completedPurchase(): { orderId: string | null; success: boolean } | null {
  try {
    const params = new URLSearchParams(location.search);
    const status = params.get('payment_status');
    if (!status) return null;
    return { orderId: params.get('order_id'), success: status === 'success' };
  } catch {
    return null;
  }
}

/** What this user owns. Gate features on THIS, never on a purchase() result you kept in memory. */
export async function hasEntitlement(productId: string, endUserRef?: string): Promise<boolean> {
  const list = await listEntitlements(endUserRef);
  return list.some(e => e.productId === productId);
}

export async function listEntitlements(endUserRef?: string): Promise<Array<{ productId: string; state: string; remaining: number | null }>> {
  const data = await api('/entitlements?endUserRef=' + encodeURIComponent(endUserRef || 'anonymous'));
  return data.entitlements || [];
}

function generateOrderId(): string {
  return 'ord_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
}

// ── In-app purchases ──────────────────────────────────────────────────────

/**
 * A purchase can succeed at the store and then be lost before our server ever
 * hears about it — the app is killed, the network drops, the phone dies in the
 * two seconds between paying and confirming. The money is gone and the user
 * has nothing, which is the worst failure this system can produce.
 *
 * So a purchase in flight is written down BEFORE the store is called and only
 * cleared once the platform has credited it. Anything still written down is
 * retried, and the store is asked directly for purchases it thinks are
 * outstanding. Modelled on the recovery pass in the Athena Android app.
 */
const PENDING_KEY = 'ab_pending_purchases';

interface PendingPurchase {
  productId: string;
  orderId: string;
  endUserRef?: string;
  purchaseToken?: string;
}

function readPending(): PendingPurchase[] {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as PendingPurchase[]) : [];
  } catch {
    return [];
  }
}

function writePending(list: PendingPurchase[]): void {
  try {
    if (list.length === 0) localStorage.removeItem(PENDING_KEY);
    else localStorage.setItem(PENDING_KEY, JSON.stringify(list));
  } catch {
    // Private mode / storage full: recovery degrades to the store query below.
  }
}

function rememberPending(entry: PendingPurchase): void {
  const list = readPending().filter(p => p.orderId !== entry.orderId);
  list.push(entry);
  writePending(list);
}

function forgetPending(orderId: string): void {
  writePending(readPending().filter(p => p.orderId !== orderId));
}

/**
 * Retry anything left in flight, then reconcile against what the store itself
 * says the user owns. Runs automatically on the first getProducts() call, and
 * is safe to call again — verification is idempotent server-side (the order id
 * is the key), so a purchase can never be credited twice.
 *
 * Consumes only AFTER the platform has accepted the purchase: consuming first
 * would burn the token and leave nothing to retry with.
 */
export async function recoverPendingPurchases(): Promise<number> {
  let recovered = 0;

  // Who bought what, read BEFORE the pass below forgets anything. The store
  // knows no endUserRef, so the store pass can only name the buyer from here
  // — and the commonest crash (app killed after Bazaar charged, before the
  // token was written down) leaves an entry with no token, which the pass
  // below forgets on its final 400. Read after it, that buyer was gone and
  // the purchase was recorded against nobody.
  const buyers = new Map(readPending().map(p => [p.orderId, p.endUserRef] as const));

  for (const entry of readPending()) {
    try {
      const result = await api('/iap/verify', {
        method: 'POST',
        body: JSON.stringify({ ...entry, simulated: !entry.purchaseToken }),
      });
      if (result.success) {
        if (result.consume && entry.purchaseToken) await consumeQuietly(entry.purchaseToken);
        forgetPending(entry.orderId);
        recovered++;
      }
    } catch (err: any) {
      // Forgotten only on the platform's final verdict — the store rejected
      // the token, or an entry written down before the store was ever called
      // carries none. Everything else (offline, 5xx, a 4xx that isn't about
      // this purchase) is left in place to try again next launch: a dead
      // entry costs one request per launch, a dropped one costs the buyer
      // what they paid.
      if (err?.final === true) forgetPending(entry.orderId);
    }
  }

  // Ask the store directly: covers a purchase that completed when we had no
  // chance to write anything down at all. Needs a live billing connection,
  // unlike the pass above, which only talks to the platform.
  const plugin = iapPlugin();
  if (!plugin || !(await connectIap())) return recovered;

  try {
    const owned = await plugin.getPurchasedProducts();
    for (const item of owned?.list || []) {
      // developerPayload carries the order id we sent at purchase time; fall
      // back to the store's own order id when it's missing.
      const orderId = item.developerPayload || item.orderId;
      try {
        const result = await api('/iap/verify', {
          method: 'POST',
          body: JSON.stringify({
            productId: item.productId,
            orderId,
            endUserRef: buyers.get(orderId),
            purchaseToken: item.purchaseToken,
          }),
        });
        if (result.success) {
          if (result.consume) await consumeQuietly(item.purchaseToken);
          forgetPending(orderId);
          recovered++;
        }
      } catch {
        // Try again next launch.
      }
    }
  } catch {
    // Store unreachable — the stored-pending pass above already ran.
  }

  return recovered;
}

async function consumeQuietly(purchaseToken: string): Promise<void> {
  try { await iapPlugin()?.consumeProduct({ purchaseToken }); } catch {}
}

async function purchaseInApp(productId: string, orderId: string, endUserRef?: string): Promise<PurchaseResult> {
  // Asked fresh, and BEFORE Bazaar's sheet: once it has opened, the buyer has
  // paid. Off when the owner turned in-app purchase off, or (live) when its
  // keys are missing or refused — the platform could not verify the purchase.
  const fresh = await getProducts().catch(() => null);
  if (!cachedInApp) {
    return { success: false, refused: true, orderId, error: 'خرید درون‌برنامه‌ای در این برنامه فعلاً فعال نیست.' };
  }
  const mode = await getPaymentMode();

  if (mode === 'sandbox') {
    const products = await getProducts();
    const product = products.find(p => p.productId === productId);
    const confirmed = await showSimulatedSheet(product?.title || productId, product?.priceToman ?? 0);
    if (!confirmed) return { success: false, cancelled: true, orderId };
    const result = await api('/iap/verify', {
      method: 'POST',
      body: JSON.stringify({ productId, orderId, endUserRef, simulated: true }),
    });
    return { success: !!result.success, orderId };
  }

  // Live: the real in-app purchase flow, then server-side verification. The
  // purchase token is worth money — whether it is valid is decided by the
  // platform against the store, never here.
  const plugin = iapPlugin();
  if (!plugin) return { success: false, refused: true, orderId, error: 'In-app purchase is unavailable in this build.' };
  // Mandatory: without it every purchaseProduct rejects with "not connected".
  if (!(await connectIap())) {
    return { success: false, refused: true, orderId, error: 'Could not reach Bazaar in-app billing. Please try again.' };
  }

  // Bazaar sells the product under its code in the owner's Pishkhan account,
  // which may differ from productId — and the platform validates the purchase
  // under that code. Read fresh (the owner may have just changed it), the
  // last list if that fails, and never guess: a guess buys the wrong code.
  // The platform is still told OUR productId.
  const listed = (fresh ?? cachedProducts)?.find(p => p.productId === productId);
  if (!listed) {
    return { success: false, refused: true, orderId, error: 'This item is not available right now. Please try again.' };
  }
  const storeCode = listed.bazaarSku || productId;

  // Written down BEFORE the store is called: if the app dies between paying
  // and confirming, this is the only record that a purchase is owed.
  rememberPending({ productId, orderId, endUserRef });

  try {
    const purchaseInfo = await plugin.purchaseProduct({ productId: storeCode, payload: orderId });
    const purchaseToken = purchaseInfo?.purchaseToken;
    rememberPending({ productId, orderId, endUserRef, purchaseToken });

    const result = await api('/iap/verify', {
      method: 'POST',
      body: JSON.stringify({ productId, orderId, endUserRef, purchaseToken }),
    });
    // Consume ONLY after the platform has accepted it — consuming first would
    // burn the token and leave nothing to retry with.
    if (result.success) {
      if (result.consume && purchaseToken) await consumeQuietly(purchaseToken);
      forgetPending(orderId);
    }
    return { success: !!result.success, orderId };
  } catch (err: any) {
    const message = String(err?.message || err || '');
    if (/cancel/i.test(message)) {
      // Nothing was bought, so nothing is owed.
      forgetPending(orderId);
      return { success: false, cancelled: true, orderId };
    }
    // Deliberately left pending: the failure may have been AFTER the money
    // moved, and recoverPendingPurchases() will settle it on next launch.
    return { success: false, orderId, error: message || 'Purchase failed' };
  }
}

// ── Simulated in-app purchase sheet (test mode only) ──

function showSimulatedSheet(title: string, priceToman: number): Promise<boolean> {
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.setAttribute('style', [
      'position:fixed', 'inset:0', 'z-index:2147483646',
      'background:rgba(0,0,0,.55)', 'display:flex',
      'align-items:flex-end', 'justify-content:center',
      'font-family:Vazirmatn,system-ui,sans-serif',
    ].join(';'));

    const sheet = document.createElement('div');
    sheet.setAttribute('style', [
      'background:#fff', 'color:#111', 'width:100%', 'max-width:420px',
      'border-radius:16px 16px 0 0', 'padding:20px', 'direction:rtl',
      'box-shadow:0 -8px 32px rgba(0,0,0,.3)',
    ].join(';'));

    const price = priceToman.toLocaleString('fa-IR');
    sheet.innerHTML =
      '<div style="font-size:13px;color:#b45309;background:#fef3c7;border-radius:8px;padding:8px 10px;margin-bottom:14px">' +
        'پرداخت آزمایشی است و مبلغی کسر نمی‌شود.' +
      '</div>' +
      '<div style="font-weight:600;font-size:16px;margin-bottom:4px"></div>' +
      '<div style="color:#666;font-size:14px;margin-bottom:18px">' + price + ' تومان</div>' +
      '<div style="display:flex;gap:8px">' +
        '<button data-ab-pay="ok" style="flex:1;padding:12px;border:0;border-radius:10px;background:#16a34a;color:#fff;font-size:15px;font-family:inherit">پرداخت آزمایشی</button>' +
        '<button data-ab-pay="cancel" style="padding:12px 16px;border:1px solid #ddd;border-radius:10px;background:#fff;color:#444;font-size:15px;font-family:inherit">انصراف</button>' +
      '</div>';
    // Product titles are app data — set as text, never parsed as HTML.
    (sheet.querySelector('div[style*="font-weight:600"]') as HTMLElement).textContent = title;

    const done = (value: boolean) => { overlay.remove(); resolve(value); };
    sheet.querySelector('[data-ab-pay="ok"]')!.addEventListener('click', () => done(true));
    sheet.querySelector('[data-ab-pay="cancel"]')!.addEventListener('click', () => done(false));
    overlay.addEventListener('click', e => { if (e.target === overlay) done(false); });

    overlay.appendChild(sheet);
    document.body.appendChild(overlay);
  });
}

