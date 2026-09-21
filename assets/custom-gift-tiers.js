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
 * Shopify owns the price, this file only a ceiling
 * ********************************************
 *
 * The automatic discount configured in the admin decides which gift units are
 * free. The very first version mirrored the threshold and the per-order cap here
 * and trusted its own count, and the two drifted the first time the cap was
 * raised in the admin: the discount allowed ten, the theme still added two, and
 * nothing in the storefront explained why. The mirror is back, but only as an
 * upper bound on what gets added. Shopify still has the last word: a unit it
 * charges for is removed, whatever this file expected.
 *
 * ********************************************
 * A gift must never be sold (21/09/2026)
 * ********************************************
 *
 * The version before this one asked Shopify by over-shooting: it put three extra
 * units in the cart, read how many came back free, then trimmed. Those three
 * units were real, priced lines for the time of a round trip (0,4 s measured),
 * on every add to cart and on every page load with a cart. Nothing held the
 * checkout button meanwhile, and seven orders left with exactly three paid
 * "free" boosters (#11921: a 69,90 EUR cart, no gift owed, 11,97 EUR charged).
 *
 * So the cart is no longer used as a probe:
 *
 * * The step and the cap from the snippet are a ceiling. The script adds at most
 *   what they allow, so in the normal case no priced gift unit ever exists. If
 *   they drift from the admin, the worst outcome is a missing gift, which is a
 *   wording problem, never a charged one.
 * * When Shopify charges a unit anyway (a product discount code won the
 *   best-discount contest), the unit is removed and that cart state is
 *   remembered, so it is not tried again on every page.
 * * Every click on the checkout button is held for the time of one cart read,
 *   and replayed only onto a cart where no gift unit is priced. A priced unit
 *   found there is removed first, wherever it came from.
 * * Until this script has loaded, the server renders the checkout button
 *   disabled whenever a gift line is priced (see sections/main-cart.liquid and
 *   sections/cart-drawer.liquid).
 *
 * What this file cannot cover is the checkout page, where it does not run. A
 * product code typed there can still turn a settled gift into a paid line. That
 * is closed on the discount's side, see documents/diagnostic-boosters-factures-21-09-2026.md.
 */

const CART_UPDATE_URL = `${window.Shopify.routes.root}cart/update.js`;
const CART_URL = `${window.Shopify.routes.root}cart.js`;

/** Pauses before retrying a refused cart write. A paid gift unit left behind is
    the one failure this file exists to prevent, so a write is not given up on
    after a single bad answer. */
const RETRY_DELAYS = [400, 1200];

/** A cart request that never answers must not hold the checkout button forever. */
const REQUEST_TIMEOUT = 8000;

/** sessionStorage key for the cart state at which Shopify last refused a gift. */
const REFUSED_KEY = 'gift-tiers:refused';

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
 * corrupts the gift durably: the missed change can move the entitlement and
 * nothing would look at the cart again. Reproduced with two quantity edits
 * 150 ms apart: 174 EUR in the cart, zero gift, forever. So the drop is
 * remembered and the reconciler runs again on a freshly fetched cart once the
 * current pass settles.
 */
let rerunNeeded = false;

/**
 * Checkout submission held back until the cart has been checked.
 * @type {{form: HTMLFormElement, submitter: HTMLElement|null}|null}
 */
let heldCheckout = null;

/** The reconciliation in progress, so that late callers can wait for it. */
let running = Promise.resolve();

/** The gate is already looking at the cart for the held checkout. */
let gating = false;

/**
 * Cart writes issued by this page and not answered yet, the theme's included.
 * The theme sends them with fetch (see assets/theme.js.liquid), and offers no
 * event before the answer, so fetch itself is the only place to count them.
 * Everything else goes straight through, untouched.
 */
let pendingCartWrites = 0;

const nativeFetch = window.fetch.bind(window);

window.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || String(input);

  if (!/\/cart\/(add|change|update|clear)(\.js)?(\?|$)/.test(url)) {
    return nativeFetch(input, init);
  }

  pendingCartWrites += 1;

  return nativeFetch(input, init).finally(() => {
    pendingCartWrites -= 1;
  });
};

/** The submit event in progress is our own replay and must go through. */
let replaying = false;

/** How many times the gate may find a priced gift and clean up before giving up. */
const GATE_ROUNDS = 3;

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

  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt += 1) {
    if (attempt > 0) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS[attempt - 1]));
    }

    try {
      const response = await fetch(CART_UPDATE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ updates, sections }),
        signal: timeoutSignal(),
      });

      if (response.ok) {
        return response.json();
      }

      console.warn('[gift-tiers] cart update refused:', response.status, await response.text());

      /* A 404 "Cannot find variant" means the gift is unpublished or archived, which
         is precisely how the previous app failed. Asking again changes nothing. */
      if (response.status === 404) {
        return null;
      }
    } catch (error) {
      console.warn('[gift-tiers] cart update failed:', error);
    }
  }

  return null;
};

/**
 * Abort signal for one cart request.
 * @returns {AbortSignal} Signal that fires after REQUEST_TIMEOUT
 */
const timeoutSignal = () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

  return controller.signal;
};

/**
 * Most gift units the snippet's step and cap allow for this cart. A ceiling on
 * what gets added, never a promise: Shopify prices the units afterwards.
 * @param {Object} cart - Cart payload from the Ajax API
 * @returns {number} Upper bound, 0 when the configuration cannot tell
 */
const giftCeiling = (cart) => {
  const subtotal = eligibleSubtotal(cart);

  if (config.step === null || !Number.isFinite(subtotal)) {
    return 0;
  }

  const steps = Math.floor(subtotal / config.step);

  return config.max === null ? steps : Math.min(steps, config.max);
};

/**
 * Identify a cart state as far as the gift is concerned: what the shopper is
 * spending and which codes compete with the gift.
 * @param {Object} cart - Cart payload from the Ajax API
 * @returns {string} Signature of the state
 */
const cartSignature = (cart) => {
  const codes = (cart.discount_codes || [])
    .filter((entry) => entry.applicable)
    .map((entry) => entry.code.toUpperCase())
    .sort();

  return `${eligibleSubtotal(cart)}|${codes.join(',')}`;
};

/**
 * Cart state at which Shopify last charged a unit this script had added. Kept
 * for the browsing session, so a cart carrying a winning product code does not
 * get a priced unit added and removed again on every page.
 * @returns {string|null} Stored signature
 */
const readRefused = () => {
  try {
    return window.sessionStorage.getItem(REFUSED_KEY);
  } catch (error) {
    return null;
  }
};

/**
 * @param {string} signature - Cart state Shopify refused a gift for
 * @returns {void}
 */
const writeRefused = (signature) => {
  try {
    window.sessionStorage.setItem(REFUSED_KEY, signature);
  } catch (error) {
    /* Private window or blocked storage: the refusal is simply learnt again */
  }
};

/**
 * Bring the gift quantity to what Shopify gives away, then let a held checkout go.
 * @param {Object} cart - Cart payload from the Ajax API
 * @returns {Promise<void>}
 */
const reconcile = (cart) => {
  if (!config) {
    return Promise.resolve();
  }

  /* A caller that arrives mid-run waits for the same run: it is re-run on a
     fresh cart before it resolves */
  if (reconciling) {
    rerunNeeded = true;
    return running;
  }

  reconciling = true;
  setBusy(true);

  running = (async () => {
    try {
      do {
        rerunNeeded = false;
        await reconcilePass(cart);

        if (rerunNeeded) {
          cart = await fetchCart();
        }
      } while (rerunNeeded);
    } catch (error) {
      console.warn('[gift-tiers] reconciliation failed:', error);
    } finally {
      reconciling = false;
      rerunNeeded = false;
      setBusy(false);
    }

    if (heldCheckout) {
      gateCheckout();
    }
  })();

  return running;
};

/**
 * Read the cart as Shopify holds it right now.
 * @returns {Promise<Object>} Cart payload from the Ajax API
 */
const fetchCart = async () => (await nativeFetch(CART_URL, { signal: timeoutSignal() })).json();

/**
 * Resolve once no cart write issued by this page is still on its way to Shopify.
 *
 * Seen in a real browser on 21/09/2026: the shopper lowers a quantity in the
 * drawer and clicks the checkout button 120 ms later. The theme's /cart/change.js
 * has not reached Shopify yet, so a cart read at that instant still shows every
 * gift free, the click goes through, and the change lands behind it: the
 * checkout opens with a gift at 3,99 EUR. Reading the cart only means something
 * once the writes ahead of it have been answered.
 * @returns {Promise<void>}
 */
const cartWritesSettled = async () => {
  const deadline = performance.now() + REQUEST_TIMEOUT;

  while (pendingCartWrites > 0 && performance.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

/**
 * Take the express checkout buttons (Shop Pay, PayPal) out of reach while the
 * gift line is being adjusted. They live in frames the submit listener below
 * never hears from, so they cannot be held and replayed like the main button.
 * @param {boolean} busy - Whether a reconciliation is in flight
 * @returns {void}
 */
const setBusy = (busy) => {
  if (busy && !document.getElementById('gift-tiers-busy-style')) {
    const style = document.createElement('style');
    style.id = 'gift-tiers-busy-style';
    style.textContent =
      '.gift-tiers-busy .additional-checkout-buttons{visibility:hidden;pointer-events:none}';
    document.head.append(style);
  }

  document.documentElement.classList.toggle('gift-tiers-busy', busy);
};

/**
 * Last look at the cart before the shopper leaves for the checkout.
 *
 * Every checkout click goes through here, not only those that land during a
 * reconciliation. The cart Shopify holds can carry a priced gift unit this page
 * never heard about: the theme's own quantity request still in flight, another
 * tab, a page rendered before the last change. So the cart is read fresh at the
 * moment of leaving, which costs one request, and the click is replayed only
 * onto a cart where every gift unit is free.
 * @returns {Promise<void>}
 */
const gateCheckout = async () => {
  if (gating) {
    return;
  }

  gating = true;

  try {
    for (let round = 0; round < GATE_ROUNDS; round += 1) {
      await cartWritesSettled();

      /* Reconcile before looking: besides removing a priced unit, this adds the
         gift a shopper is owed when they click before it has been added */
      await reconcile(await fetchCart());
      await cartWritesSettled();

      const { total, free } = giftUnits(await fetchCart());

      if (total === free && pendingCartWrites === 0) {
        replayCheckout();
        return;
      }
    }
  } catch (error) {
    console.warn('[gift-tiers] checkout gate failed:', error);
  } finally {
    gating = false;
  }

  /* The cart could not be brought to a state where every gift is free. Sending
     the shopper on would sell a gift, and a dead button would lose the order:
     the cart page re-renders from the server and this script starts over there. */
  if (heldCheckout) {
    heldCheckout = null;
    console.warn('[gift-tiers] checkout held back, cart not settled');
    window.location.assign(`${window.Shopify.routes.root}cart`);
  }
};

/**
 * Submit the held checkout form for real.
 * @returns {void}
 */
const replayCheckout = () => {
  const held = heldCheckout;
  heldCheckout = null;

  if (!held) {
    return;
  }

  replaying = true;

  let { form } = held;
  let submitter = held.submitter;

  /* The drawer is re-rendered after every cart change, often while the click is
     being held: the form that was clicked is then out of the document, and a
     detached form submits nothing (seen in a real browser on 21/09/2026). A
     bare form does the same job, the cart page's note and quantities only live
     in a form that is never re-rendered. */
  if (!form.isConnected) {
    form = document.createElement('form');
    form.method = 'POST';
    form.action = `${window.Shopify.routes.root}cart`;
    form.hidden = true;
    document.body.append(form);
    submitter = null;
  }

  if (submitter && typeof form.requestSubmit === 'function') {
    form.requestSubmit(submitter);
  } else {
    /* form.submit() would drop the button's name, and /cart only redirects to
       the checkout when it receives it */
    const field = document.createElement('input');
    field.type = 'hidden';
    field.name = 'checkout';
    form.append(field);
    form.submit();
  }

  replaying = false;
};

/**
 * One reconciliation round: remove what Shopify charges, add what the ceiling
 * still allows, then tell the theme.
 * @param {Object} cart - Cart payload from the Ajax API
 * @returns {Promise<Object|null>} Cart after the round, null when a write was lost
 */
const reconcilePass = async (cart) => {
  const { total, free } = giftUnits(cart);
  const signature = cartSignature(cart);

  const needsTrim = total > free;
  const mayAdd = !needsTrim && free < giftCeiling(cart) && readRefused() !== signature;

  if (!needsTrim && !mayAdd) {
    return cart;
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

  if (mayAdd) {
    const added = await setGiftQuantity(current, giftCeiling(current), sections);
    if (!added) return null;
    current = added;
  }

  const answer = giftUnits(current);

  if (answer.total > answer.free) {
    /* Shopify is charging for units: keep exactly what it gave away. When they
       are units this pass just added, remember the state so the next page does
       not put a priced unit back in the cart to learn the same thing. */
    if (mayAdd) {
      writeRefused(signature);
    }

    const trimmed = await setGiftQuantity(current, answer.free, sections);
    if (!trimmed) return null;
    current = trimmed;
  }

  const giftsChanged = giftUnits(current).total !== giftsOnEntry;

  /* The cart page changes a quantity by navigating to /cart/change, so it renders
     before we have touched the gift and then has no way to update itself: it does
     not listen for cart:refresh, only the drawer does. Reloading is the honest
     fix there, guarded on an actual change so it cannot loop the page. A held
     checkout makes the reload pointless, the shopper is leaving. */
  if (giftsChanged && !heldCheckout && window.themeVariables?.settings?.pageType === 'cart') {
    window.location.reload();
    return current;
  }

  document.documentElement.dispatchEvent(
    new CustomEvent('cart:change', {
      bubbles: true,
      detail: { baseEvent: 'gift-tiers:reconcile', cart: current },
    })
  );

  /* Have the drawer re-fetch itself once the theme's delayed write has passed */
  const remaining = Math.max(0, STALE_RENDER_WINDOW - (performance.now() - windowOpenedAt));

  setTimeout(() => {
    document.documentElement.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true }));
  }, remaining);

  return current;
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
    /* Drives the sentence and the ceiling on added units. null when the
       configuration cannot say how much a gift costs: the bar then hides instead
       of quoting a made-up amount, and no gift is added, since the only other way
       to find out how many are owed is to put priced units in the cart. */
    step: step === null ? null : positiveNumber(Math.round(step * rate)),
    /* Per-order limit of the discount, mirrored here for the sentence and the
       ceiling. null means "not configured", never "limit not reached". */
    max: positiveNumber(definition.max),
  };

  /* A returning shopper can land with a cart that already crossed a threshold */
  fetch(CART_URL, { signal: timeoutSignal() })
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

/* The checkout buttons of the drawer and of the cart page are plain form submits,
   so nothing used to stop a shopper from leaving while the gift line was being
   adjusted. Captured on the document because the drawer's form is re-rendered
   after every cart change. The click is held, not dropped: gateCheckout replays
   it once it has seen a cart with no priced gift unit. */
document.addEventListener(
  'submit',
  (event) => {
    const form = event.target;

    /* No configuration means no gift on this page, nothing to protect */
    if (replaying || !config || !(form instanceof HTMLFormElement)) {
      return;
    }

    const submitter = event.submitter || form.querySelector('[name="checkout"]');

    if (!submitter || submitter.getAttribute('name') !== 'checkout') {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    submitter.setAttribute('aria-busy', 'true');
    heldCheckout = { form, submitter };

    /* A running reconciliation opens the gate itself when it ends */
    if (!reconciling) {
      gateCheckout();
    }
  },
  true
);

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
       instead of quoting an amount it cannot compute */
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
