import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
  startUrls,
  maxResults = 25,
  useProxy = true,
} = input;

/* ======================
   STATE
====================== */
const STATE_KEY = 'STATE';
const state = (await Actor.getValue(STATE_KEY)) || { index: 0 };

/* ======================
   PROXY
====================== */
const proxyConfiguration = useProxy
  ? await Actor.createProxyConfiguration({ useApifyProxy: true })
  : undefined;

/* ======================
   HELPERS
====================== */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* ======================
   CRAWLER
====================== */
const crawler = new PlaywrightCrawler({
  proxyConfiguration,
  maxConcurrency: 1,
  navigationTimeoutSecs: 60,
  requestHandlerTimeoutSecs: 300,

  async requestHandler({ page, request, log }) {
    log.info('Opening Google Maps');

    // Block heavy assets
    await page.route('**/*', route => {
      const t = route.request().resourceType();
      if (['image', 'media', 'font'].includes(t)) route.abort();
      else route.continue();
    });

    await page.goto(request.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('div[role="feed"]');
    await sleep(2000);

    // Scroll to load cards
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => {
        document.querySelector('div[role="feed"]')?.scrollBy(0, 8000);
      });
      await sleep(1500);
    }

    let cards = await page.$$('div[role="article"]');
    log.info(`Cards loaded: ${cards.length}`);

    let extracted = 0;

    for (let i = state.index; i < cards.length && extracted < maxResults; i++) {
      try {
        cards = await page.$$('div[role="article"]');
        const card = cards[i];
        if (!card) break;

        // Extract placeId BEFORE click
        const placeId = await card.getAttribute('data-place-id');
        if (!placeId) continue;

        await card.click();
        await page.waitForSelector('h1.DUwDvf', { timeout: 10000 });
        await sleep(800);

        const data = await page.evaluate(() => {
          const pick = s => document.querySelector(s)?.textContent?.trim() || '';
          return {
            title: pick('h1.DUwDvf'),
            category: pick('button.DkEaL'),
            rating: pick('div.F7nice span[aria-hidden="true"]'),
            phone: pick('button[data-item-id*="phone"]'),
            website: document.querySelector('a[data-item-id*="authority"]')?.href || '',
          };
        });

        if (!data.title) throw new Error('No title');

        data.place_id = placeId;

        await Actor.pushData(data);

        extracted++;
        state.index = i + 1;
        await Actor.setValue(STATE_KEY, state);

        log.info(`Extracted ${extracted}: ${data.title}`);

        //  GO BACK TO LIST (CRITICAL)
        await page.keyboard.press('Escape');
        await sleep(700);

      } catch (err) {
        log.warning(`Skipped index ${i}: ${err.message}`);
        state.index = i + 1;
      }
    }

    log.info(`Run finished with ${extracted} places`);
  },
});

/* ======================
   RUN
====================== */
await crawler.run(startUrls);
await Actor.exit();
