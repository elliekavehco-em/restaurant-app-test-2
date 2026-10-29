/**
 * What this app sells. The platform reads this file and serves it back to the
 * app at runtime, so prices can be changed here (or by asking in chat) without
 * touching any other code.
 *
 * kind:
 *   'consumable'      buy repeatedly — coins, credits, extra lives
 *   'non_consumable'  buy once, keep forever — remove ads, unlock pro
 *   'subscription'    a plan that RUNS OUT — monthly, yearly, 30 days, or a
 *                     credits pack — kept by server/lib/subscriptions.ts:
 *     { id: 'gold_month', title: '…', priceToman: 59000, kind: 'subscription', model: 'time', days: 30, level: 2 }
 *     { id: 'ai_100', title: '…', priceToman: 30000, kind: 'subscription', model: 'credits', credits: 100, days: 90 }
 */
export const PRODUCTS = [
  // { id: 'coins_100', title: '۱۰۰ سکه', priceToman: 5000, kind: 'consumable' },
  // { id: 'remove_ads', title: 'حذف تبلیغات', priceToman: 25000, kind: 'non_consumable' },
] as const;
