/**
 * ----------------------------------------------------------------------------
 * GIFT TIERS
 * ----------------------------------------------------------------------------
 * Custom addition to the Impact theme. Not part of Maestrooo's base code, so it
 * lives in its own asset and snippet and can be removed without touching the
 * theme's own files (except the render calls in cart-drawer and main-cart).
 *
 * Replaces the "Monster Cart Upsell+Free Gifts" app, which promised threshold
 * gifts entirely client-side and kept displaying "you unlocked a booster" long
 * after the gift products had been archived, with nothing added to the cart.
 *
 * Two halves, deliberately separated:
 *
 *   1. A reconciler that keeps the gift line in sync with the cart subtotal. It
 *      decides presence and quantity only, never price.
 *   2. A <gift-tiers-bar> element that renders progress toward the next tier.
 *
 * Pricing stays authoritative on Shopify's side: a single automatic "Buy X get
 * Y" discount grants one free gift per threshold step, capped per order. That
 * discount was verified against the live store to behave as follows:
 *
 *   - it repeats once per completed step (2 free at 174 EUR, 3 at 244 EUR)
 *   - any gift unit beyond the entitlement is charged at full price
 *
 * So if this script breaks, or a shopper hand-edits the cart, checkout still
 * charges correctly. That split is the whole reason for the rewrite: the old
 * app made the browser the only source of truth, so a silent failure became a
 * broken promise to the customer.
 *
 * One gift product with a varying quantity, rather than one product per tier:
 * two automatic discounts do not stack outside Shopify Plus, which was measured
 * on this store, so a second discount would simply have overridden the first.
 */

const CART_UPDATE_URL = `${window.Shopify.routes.root}cart/update.js`;
const CART_URL = `${window.Shopify.routes.root}cart.js`;

/**
 * Impact rewrites the drawer's line items 1250 ms after a cart:change, reusing the
 * markup it fetched before we added the gift (see CartDrawer._onCartChanged in
 * theme.js). Our own re-render lands earlier, so that delayed write would put the
 * stale, giftless markup back and the shopper would have to reload to see the gift.
 * Refreshing past that window is what keeps the drawer truthful.
 */
const STALE_RENDER_WINDOW = 1400;

/** @type {{variantId: number, thresholds: number[], reward: string}|null} */
let config = null;
let reconciling = false;

/**
 * Format an amount in cents using the active market's currency.
 * @param {number} cents - Amount in cents
 * @returns {string} Localized currency string
 */
const formatMoney = (cents) =>
  new Intl.NumberFormat(document.documentElement.lang || undefined, {
    style: 'currency',
    currency: window.Shopify?.currency?.active || 'EUR',
  }).format(cents / 100);

/**
 * Sum the cart lines that count toward a tier, excluding the gift itself.
 * @param {Object} cart - Cart payload from the Ajax API
 * @returns {number} Eligible subtotal in cents
 */
const eligibleSubtotal = (cart) => {
  const gross = cart.items
    .filter((item) => item.variant_id !== config?.variantId)
    .reduce((sum, item) => sum + item.final_line_price, 0);

  /* Same reasoning as Impact's free shipping bar: a cart-level discount already
     reduced what the customer pays, so it must not also count toward the goal */
  const discount = (cart.cart_level_discount_applications || []).reduce(
    (sum, application) => sum + application.total_allocated_amount,
    0
  );

  return Math.max(0, gross - discount);
};

/**
 * How many gifts the customer has earned at a given subtotal.
 * @param {number} subtotal - Eligible subtotal in cents
 * @returns {number} Number of gift units earned
 */
const earnedQuantity = (subtotal) =>
  config.thresholds.filter((threshold) => subtotal >= threshold).length;

/**
 * Build the /cart/update.js payload that brings the gift line in line with the
 * subtotal. Shopify may hold the gift across several lines, so every matching
 * line is addressed and the surplus collapsed into one.
 * @param {Object} cart - Cart payload from the Ajax API
 * @param {number} subtotal - Eligible subtotal in cents
 * @returns {Object} Updates keyed by line key or variant ID, empty when nothing to do
 */
const buildUpdates = (cart, subtotal) => {
  const lines = cart.items.filter((item) => item.variant_id === config.variantId);
  const current = lines.reduce((sum, line) => sum + line.quantity, 0);
  const desired = earnedQuantity(subtotal);

  if (current === desired) {
    return {};
  }

  if (lines.length === 0) {
    /* update.js creates the line when the variant isn't in the cart yet */
    return { [config.variantId]: desired };
  }

  const updates = {};

  lines.forEach((line, index) => {
    updates[line.key] = index === 0 ? desired : 0;
  });

  return updates;
};

/**
 * Add or remove gift units so the cart matches what the customer has earned.
 * @param {Object} cart - Cart payload from the Ajax API
 * @returns {Promise<void>}
 */
const reconcile = async (cart) => {
  if (reconciling || !config) {
    return;
  }

  const updates = buildUpdates(cart, eligibleSubtotal(cart));

  if (Object.keys(updates).length === 0) {
    return;
  }

  reconciling = true;

  /* The theme's delayed write is scheduled from the event we are reacting to, not
     from our own request, so count the window from here rather than from the end
     of the update. Saves the shopper the round trip we just spent. */
  const windowOpenedAt = performance.now();

  try {
    /* Let the drawer declare which sections it needs re-rendered, exactly as the
       theme's own line-item quantity handler does */
    const sections = [];
    document.documentElement.dispatchEvent(
      new CustomEvent('cart:prepare-bundled-sections', { bubbles: true, detail: { sections } })
    );

    const response = await fetch(CART_UPDATE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ updates, sections }),
    });

    if (!response.ok) {
      /* A 404 "Cannot find variant" means the gift is unpublished or archived,
         which is precisely how the previous app failed. Leave the cart alone and
         say so in the console rather than showing an unfulfilled promise. */
      console.warn('[gift-tiers] cart update refused:', response.status, await response.text());
      return;
    }

    const updatedCart = await response.json();

    document.documentElement.dispatchEvent(
      new CustomEvent('cart:change', {
        bubbles: true,
        detail: { baseEvent: 'gift-tiers:reconcile', cart: updatedCart },
      })
    );

    /* Have the drawer re-fetch itself once the theme's delayed write has passed */
    const remaining = Math.max(0, STALE_RENDER_WINDOW - (performance.now() - windowOpenedAt));

    setTimeout(() => {
      document.documentElement.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true }));
    }, remaining);
  } catch (error) {
    console.warn('[gift-tiers] reconciliation failed:', error);
  } finally {
    reconciling = false;
  }
};

/**
 * Register the gift configuration. Called by every <gift-tiers-bar> instance but
 * only honoured once, since the drawer and the cart page both render the bar.
 * @param {{variantId: number, thresholds: number[], reward: string}} definition - Thresholds in shop-currency cents
 * @returns {void}
 */
const registerConfig = (definition) => {
  if (config) {
    return;
  }

  /* Thresholds are authored in the shop currency; other markets need converting,
     otherwise 80 EUR would silently become 80 CHF on the Swiss market */
  const rate = parseFloat(window.Shopify?.currency?.rate) || 1;

  config = {
    ...definition,
    thresholds: definition.thresholds
      .map((threshold) => Math.round(threshold * rate))
      .sort((first, second) => first - second),
  };

  /* A returning shopper can land with a cart that already crossed a threshold */
  fetch(CART_URL)
    .then((response) => response.json())
    .then(reconcile)
    .catch((error) => console.warn('[gift-tiers] initial sync failed:', error));
};

document.addEventListener('cart:change', (event) => {
  /* Skip the event we dispatch ourselves, otherwise reconciliation recurses */
  if (event.detail?.baseEvent === 'gift-tiers:reconcile') {
    return;
  }

  reconcile(event.detail.cart);
});

/**
 * Progress bar toward the next gift tier. Display only: it never writes to the
 * cart, so a rendering bug cannot cost the merchant stock.
 */
class GiftTiersBar extends HTMLElement {
  connectedCallback() {
    try {
      registerConfig(JSON.parse(this.getAttribute('config')));
    } catch (error) {
      console.warn('[gift-tiers] invalid configuration:', error);
      return;
    }

    this._onCartChangedListener = this._onCartChanged.bind(this);
    document.addEventListener('cart:change', this._onCartChangedListener);

    this.render(parseInt(this.getAttribute('subtotal'), 10) || 0);
  }

  disconnectedCallback() {
    document.removeEventListener('cart:change', this._onCartChangedListener);
  }

  _onCartChanged(event) {
    this.render(eligibleSubtotal(event.detail.cart));
  }

  /**
   * Paint the bar and the message for a given subtotal.
   * @param {number} subtotal - Eligible subtotal in cents
   * @returns {Promise<void>}
   */
  async render(subtotal) {
    const messageElement = this.querySelector('[data-gift-tiers-message]');

    if (!messageElement || !config) {
      return;
    }

    const maxThreshold = config.thresholds[config.thresholds.length - 1];
    const nextThreshold = config.thresholds.find((threshold) => subtotal < threshold);

    messageElement.innerHTML = nextThreshold
      ? this.getAttribute('unreached-message')
          .replace('@@remaining@@', `<span class="bold text-accent">${formatMoney(nextThreshold - subtotal)}</span>`)
          .replace('@@reward@@', config.reward)
      : this.getAttribute('all-reached-message');

    await window.customElements.whenDefined('progress-bar');
    const progressBarElement = this.querySelector('progress-bar');

    if (progressBarElement) {
      progressBarElement.valueMax = maxThreshold;
      progressBarElement.valueNow = Math.min(subtotal, maxThreshold);
    }
  }
}

if (!window.customElements.get('gift-tiers-bar')) {
  window.customElements.define('gift-tiers-bar', GiftTiersBar);
}
