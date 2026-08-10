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
 * ********************************************
 * Shopify owns the rule, this file owns nothing
 * ********************************************
 *
 * The automatic discount configured in the admin is the only definition of who
 * earns how many gifts. This script never recomputes it. An earlier version did,
 * by mirroring the threshold and the per-order cap here, and the two drifted the
 * first time the cap was raised in the admin: the discount allowed ten, the theme
 * still added two, and nothing in the storefront explained why.
 *
 * Instead we ask. Shopify answers precisely: put more gift units in the cart than
 * are owed and it discounts exactly the number earned while charging the rest, on
 * its own separate line. So the reconciler over-shoots by a few units, reads back
 * how many Shopify actually gave away, and trims to that number. Whatever the
 * admin says today, the cart follows, including a rule this file has never heard
 * of. Raising the cap or moving the threshold needs no deploy.
 *
 * The intermediate over-shoot never reaches the screen: the drawer is only asked
 * to re-render once the trimming is done.
 *
 * Pricing stays authoritative on Shopify's side throughout. If this script fails,
 * or a shopper hand-edits the cart, checkout still charges correctly.
 */

const CART_UPDATE_URL = `${window.Shopify.routes.root}cart/update.js`;
const CART_URL = `${window.Shopify.routes.root}cart.js`;

/**
 * How many extra units to put in the cart when asking Shopify how many it owes.
 * Big enough to clear several thresholds at once so a large cart settles in one
 * round trip, small enough that the surplus is trivial if a request is lost.
 */
const PROBE_HEADROOM = 3;

/** Stops a misbehaving discount from looping the probe forever. */
const MAX_PROBES = 4;

/**
 * Impact rewrites the drawer's line items 1250 ms after a cart:change, reusing the
 * markup it fetched before we touched the gift (see CartDrawer._onCartChanged in
 * theme.js). Our own re-render lands earlier, so that delayed write would put the
 * stale markup back and the shopper would have to reload to see the gift.
 */
const STALE_RENDER_WINDOW = 1400;

/** @type {{variantId: number, step: number|null, max: number|null, reward: string}|null} */
let config = null;
let reconciling = false;

/**
 * A cart:change landed while a reconciliation was in flight. Dropping it
 * corrupts the gift durably: the missed change can move the entitlement, and
 * the lastSubtotal guard then blocks every later probe because the subtotal no
 * longer grows. Reproduced with two quantity edits 150 ms apart: 174 EUR in the
 * cart, zero gift, forever. So the drop is remembered and the reconciler runs
 * again on a freshly fetched cart once the current pass settles.
 */
let rerunNeeded = false;

/**
 * Eligible subtotal at the last completed reconciliation, so we only pay for a
 * probe when the shopper spent more than they had before.
 */
let lastSubtotal = null;

/**
 * Read a whole positive number out of untrusted input.
 *
 * Nothing here is hand-typed: the numbers come from the configuration attribute
 * and from cart payloads. But a shopper once read "Ajoutez NaN EUR" on the cart
 * page, because a single missing or non-numeric value turns every later
 * computation into NaN silently, and Math.max(0, NaN) is NaN rather than 0. So
 * every number is now checked where it enters, and an unusable one becomes null
 * instead of travelling to the screen.
 *
 * @param {*} value - Candidate read from an attribute or a cart payload
 * @returns {number|null} The number, or null when it cannot be trusted
 */
const positiveNumber = (value) => {
  const number = Number(value);

  return Number.isFinite(number) && number > 0 ? number : null;
};

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
 * Sum the cart lines that count toward a gift, excluding the gift itself.
 *
 * Order-level discount codes are deliberately NOT deducted, because Shopify does
 * not deduct them either when it decides how many gifts are owed. Measured twice
 * on the live store on 10/08/2026, with VCOLLECT10 (-10 % on the order) applied:
 *
 * * 329,80 EUR of products, 296,82 EUR actually paid, 4 gifts given
 * * 164,90 EUR of products, 148,41 EUR actually paid, 2 gifts given
 *
 * Both counts follow the price before the code, never the price paid. Shopify
 * applies product discounts, which is what the gift is, before order discounts,
 * so the threshold is read on the undiscounted lines.
 *
 * Impact's free shipping bar does subtract them, and this function copied it
 * until today. That is what put two different rules on the same screen: the cart
 * showed 4 gifts while the bar still asked for 103,18 EUR more.
 *
 * @param {Object} cart - Cart payload from the Ajax API
 * @returns {number} Eligible subtotal in cents
 */
const eligibleSubtotal = (cart) =>
  Math.max(
    0,
    cart.items
      .filter((item) => item.variant_id !== config?.variantId)
      .reduce((sum, item) => sum + item.final_line_price, 0)
  );

/**
 * Split the gift units into those Shopify is giving away and those it is charging.
 * Shopify keeps the two on separate lines, so each line is all-or-nothing.
 * @param {Object} cart - Cart payload from the Ajax API
 * @returns {{total: number, free: number, lines: Array<Object>}} Gift unit counts
 */
const giftUnits = (cart) => {
  const lines = cart.items.filter((item) => item.variant_id === config.variantId);

  return {
    lines,
    total: lines.reduce((sum, line) => sum + line.quantity, 0),
    free: lines
      .filter((line) => line.final_line_price === 0)
      .reduce((sum, line) => sum + line.quantity, 0),
  };
};

/**
 * Set the gift to an exact number of units and return the cart Shopify answers with.
 * @param {Object} cart - Current cart payload
 * @param {number} quantity - Desired number of gift units
 * @param {Array<string>} sections - Theme sections to bundle into the response
 * @returns {Promise<Object|null>} Updated cart, or null when Shopify refused
 */
const setGiftQuantity = async (cart, quantity, sections) => {
  const { lines } = giftUnits(cart);
  const updates = {};

  if (lines.length === 0) {
    /* update.js creates the line when the variant isn't in the cart yet */
    updates[config.variantId] = quantity;
  } else {
    /* Key by line key: Shopify splits gifts across lines, and this collapses them
       back into one instead of letting the surplus drift */
    lines.forEach((line, index) => {
      updates[line.key] = index === 0 ? quantity : 0;
    });
  }

  const response = await fetch(CART_UPDATE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ updates, sections }),
  });

  if (!response.ok) {
    /* A 404 "Cannot find variant" means the gift is unpublished or archived, which
       is precisely how the previous app failed. Say so rather than pretend. */
    console.warn('[gift-tiers] cart update refused:', response.status, await response.text());
    return null;
  }

  return response.json();
};

/**
 * Bring the gift quantity to whatever Shopify is willing to give away.
 * @param {Object} cart - Cart payload from the Ajax API
 * @returns {Promise<void>}
 */
const reconcile = async (cart) => {
  if (!config) {
    return;
  }

  if (reconciling) {
    rerunNeeded = true;
    return;
  }

  reconciling = true;

  try {
    /* After a dropped change the settled snapshot is stale, so the pass must not
       trust its lastSubtotal guard */
    let force = false;

    do {
      rerunNeeded = false;
      await reconcilePass(cart, force);

      if (rerunNeeded) {
        cart = await (await fetch(CART_URL)).json();
        force = true;
      }
    } while (rerunNeeded);
  } catch (error) {
    console.warn('[gift-tiers] reconciliation failed:', error);
  } finally {
    reconciling = false;
    rerunNeeded = false;
  }
};

/**
 * One reconciliation round: decide, probe, trim, then tell the theme.
 * @param {Object} cart - Cart payload from the Ajax API
 * @param {boolean} force - Probe even when the guards see nothing new
 * @returns {Promise<void>}
 */
const reconcilePass = async (cart, force) => {
  const subtotal = eligibleSubtotal(cart);
  const { total, free } = giftUnits(cart);

  /* Shopify has already priced this cart. If it is charging for gift units, that
     is the answer, no probe needed. If everything is free and the shopper has not
     spent more than last time, there is nothing new to earn either. */
  const needsTrim = total > free;
  const mightEarnMore = lastSubtotal === null || subtotal > lastSubtotal;

  if (!needsTrim && !mightEarnMore && !force) {
    return;
  }

  /* The theme's delayed write is scheduled from the event we are reacting to, not
     from our own requests, so count the window from here */
  const windowOpenedAt = performance.now();
  const giftsOnEntry = total;

  /* Let the drawer declare which sections it needs re-rendered, exactly as the
     theme's own line-item quantity handler does */
  const sections = [];
  document.documentElement.dispatchEvent(
    new CustomEvent('cart:prepare-bundled-sections', { bubbles: true, detail: { sections } })
  );

  let current = cart;
  let settled = false;

  for (let probe = 0; probe < MAX_PROBES && !settled; probe += 1) {
    const units = giftUnits(current);

    if (units.total > units.free) {
      /* Shopify is charging for the surplus: keep exactly what it gave away */
      if (units.total !== units.free) {
        const trimmed = await setGiftQuantity(current, units.free, sections);
        if (!trimmed) return;
        current = trimmed;
      }
      settled = true;
      break;
    }

    /* Everything in the cart is free, so ask whether more would be */
    const asked = await setGiftQuantity(current, units.total + PROBE_HEADROOM, sections);
    if (!asked) return;
    current = asked;

    const answer = giftUnits(current);

    if (answer.free < answer.total) {
      const trimmed = await setGiftQuantity(current, answer.free, sections);
      if (!trimmed) return;
      current = trimmed;
      settled = true;
    }
    /* Otherwise every probed unit came back free: loop and ask for more */
  }

  const settledSubtotal = eligibleSubtotal(current);

  /* A subtotal that did not add up must never settle in: the guard above compares
     against it, and NaN loses every comparison, so a single bad payload would
     freeze the probe for the rest of the session. null means "not measured",
     which makes the next change probe again. */
  lastSubtotal = Number.isFinite(settledSubtotal) ? settledSubtotal : null;

  const giftsChanged = giftUnits(current).total !== giftsOnEntry;

  /* The cart page changes a quantity by navigating to /cart/change, so it renders
     before we have touched the gift and then has no way to update itself: it does
     not listen for cart:refresh, only the drawer does. Reloading is the honest
     fix there. Guarded on an actual change so the probe's own round trip, which
     ends where it started, cannot loop the page. */
  if (giftsChanged && window.themeVariables?.settings?.pageType === 'cart') {
    window.location.reload();
    return;
  }

  document.documentElement.dispatchEvent(
    new CustomEvent('cart:change', {
      bubbles: true,
      detail: { baseEvent: 'gift-tiers:reconcile', cart: current },
    })
  );

  /* Have the drawer re-fetch itself once the theme's delayed write has passed.
     This is also what keeps the probe's over-shoot off the screen. */
  const remaining = Math.max(0, STALE_RENDER_WINDOW - (performance.now() - windowOpenedAt));

  setTimeout(() => {
    document.documentElement.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true }));
  }, remaining);
};

/**
 * Register the gift configuration. Called by every <gift-tiers-bar> instance but
 * only honoured once, since the drawer and the cart page both render the bar.
 * @param {{variantId: number, step: number, max: number, reward: string}} definition - Step in shop-currency cents
 * @returns {void}
 */
const registerConfig = (definition) => {
  if (config) {
    return;
  }

  const variantId = positiveNumber(definition?.variantId);

  /* Without the variant there is no gift to add and nothing to promise. Staying
     unregistered keeps the feature off rather than half on, and leaves the next
     instance free to register a well-formed configuration. */
  if (variantId === null) {
    console.warn('[gift-tiers] unusable configuration, gift disabled:', definition);
    return;
  }

  /* The step is authored in the shop currency; other markets need converting,
     otherwise 80 EUR would silently become 80 CHF on the Swiss market */
  const rate = positiveNumber(window.Shopify?.currency?.rate) || 1;
  const step = positiveNumber(definition.step);

  config = {
    variantId,
    reward: typeof definition.reward === 'string' ? definition.reward : '',
    /* Sentence only. null when the configuration cannot say how much a gift
       costs: the bar then hides instead of quoting a made-up amount, and the
       cart keeps handing out gifts all the same. */
    step: step === null ? null : positiveNumber(Math.round(step * rate)),
    /* Per-order limit of the discount, mirrored here for the sentence only.
       null means "not configured", never "limit not reached". */
    max: positiveNumber(definition.max),
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
 * Progress bar toward the next gift. Display only: it never writes to the cart,
 * so a wrong step here costs a wrong sentence, never a wrong charge.
 */
class GiftTiersBar extends HTMLElement {
  connectedCallback() {
    try {
      registerConfig(JSON.parse(this.getAttribute('config')));
    } catch (error) {
      console.warn('[gift-tiers] invalid configuration:', error);
      this.hidden = true;
      return;
    }

    /* registerConfig turns down a definition it cannot use. Without one there is
       no gift to track, so the bar stays off the page rather than listening for
       changes it has no way to describe. */
    if (!config) {
      this.hidden = true;
      return;
    }

    this._onCartChangedListener = this._onCartChanged.bind(this);
    document.addEventListener('cart:change', this._onCartChangedListener);

    this.render(parseInt(this.getAttribute('subtotal'), 10) || 0, parseInt(this.getAttribute('earned'), 10) || 0);
  }

  disconnectedCallback() {
    document.removeEventListener('cart:change', this._onCartChangedListener);
  }

  _onCartChanged(event) {
    const cart = event.detail?.cart;

    /* Any script on the page may dispatch cart:change, and the theme's own event
       is not the only one we hear. Only something shaped like a cart can be
       turned into a sentence. */
    if (!cart || !Array.isArray(cart.items)) {
      return;
    }

    this.render(eligibleSubtotal(cart), giftUnits(cart).free);
  }

  /**
   * Paint the bar and the message.
   * @param {number} subtotal - Eligible subtotal in cents
   * @param {number} earned - Gift units Shopify is currently giving away
   * @returns {Promise<void>}
   */
  async render(subtotal, earned) {
    const messageElement = this.querySelector('[data-gift-tiers-message]');

    if (!messageElement || !config) {
      return;
    }

    /* No usable step, no honest sentence: the bar takes itself off the page
       instead of quoting an amount it cannot compute. The gift itself does not
       depend on this, the reconciler keeps working. */
    this.hidden = config.step === null;

    if (this.hidden) {
      return;
    }

    /* A cart that would not add up used to reach the shopper as "Ajoutez NaN EUR"
       (seen on the cart page on 10/08/2026). Keeping the sentence already on
       screen, which was computed from numbers that did add up, beats replacing it
       with one that means nothing. */
    if (!Number.isFinite(subtotal) || !Number.isFinite(earned)) {
      console.warn('[gift-tiers] repaint skipped, unusable numbers:', { subtotal, earned });
      return;
    }

    /* Two independent signals that there is nothing left to promise, and either
       one is enough. Shopify handing out fewer gifts than the steps call for is
       the live evidence that its per-order limit is reached; config.max is the
       mirror of that limit, and it answers one step earlier, at the exact moment
       the last gift is earned, where the live evidence still looks like a shopper
       who is simply on their way to the next step. */
    const expected = Math.floor(subtotal / config.step);
    const capped = (config.max !== null && earned >= config.max) || (earned > 0 && earned < expected);
    const towardNext = subtotal - earned * config.step;

    messageElement.innerHTML = capped
      ? this.getAttribute('all-reached-message')
      : this.getAttribute('unreached-message')
          .replace('@@remaining@@', `<span class="bold text-accent">${formatMoney(Math.max(0, config.step - towardNext))}</span>`)
          .replace('@@reward@@', config.reward);

    await window.customElements.whenDefined('progress-bar');
    const progressBarElement = this.querySelector('progress-bar');

    if (progressBarElement) {
      progressBarElement.valueMax = config.step;
      progressBarElement.valueNow = capped ? config.step : Math.max(0, Math.min(config.step, towardNext));
    }
  }
}

if (!window.customElements.get('gift-tiers-bar')) {
  window.customElements.define('gift-tiers-bar', GiftTiersBar);
}
