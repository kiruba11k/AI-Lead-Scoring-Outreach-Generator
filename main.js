import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import OpenAI from 'openai';

await Actor.init();

/* ======================
   CONFIG
====================== */
const RESULTS_PER_RUN = 25; // hard free-tier limit
const STATE_KEY = 'SCRAPE_STATE';
const SEEN_KEY = 'SEEN_PLACES';

/* ======================
   INPUT
====================== */
const input = await Actor.getInput() || {};
const {
  startUrls,
  services = ['Web Design'],
  tone = 'friendly',
  language = 'English',
  openaiApiKey,
  useProxy = true,
} = input;

/* ======================
   STATE (CONTINUATION)
====================== */
const state = (await Actor.getValue(STATE_KEY)) || { lastIndex: 0 };
let startIndex = state.lastIndex;

/* ======================
   DEDUP STORE
====================== */
const seen = (await Actor.getValue(SEEN_KEY)) || {};

/* ======================
   OPENAI
====================== */
const openai = openaiApiKey
  ? new OpenAI({ apiKey: openaiApiKey })
  : null;

/* ======================
   PROXY
====================== */
const proxyConfiguration = useProxy
  ? await Actor.createProxyConfiguration({ useApifyProxy: true })
  : undefined;

/* ======================
   HELPERS
====================== */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function detectIndustry(category = '') {
  const c = category.toLowerCase();
  if (c.includes('restaurant') || c.includes('cafe')) return 'restaurant';
  if (c.includes('clinic') || c.includes('hospital')) return 'healthcare';
  if (c.includes('agency') || c.includes('marketing')) return 'agency';
  if (c.includes('salon') || c.includes('spa')) return 'salon';
  return 'local_business';
}

function analyzeSentiment(rating) {
  const r = Number(rating) || 0;
  if (r >= 4.2) return 'positive';
  if (r >= 3.5) return 'neutral';
  return 'negative';
}

/* ======================
   AI PITCH
====================== */
async function generatePitches(data) {
  if (!openai) {
    return {
      whatsapp: `Hi ${data.title}, we help businesses grow using ${services.join(', ')}.`,
      email_subject: `Quick idea for ${data.title}`,
      email_body: `Hi ${data.title},\n\nWe help similar businesses with ${services.join(', ')}.\n\nBest regards`,
    };
  }

  const prompt = `
Business: ${data.title}
Industry: ${data.industry}
Rating: ${data.rating}
Services: ${services.join(', ')}

Write WhatsApp + email outreach in ${language}, tone ${tone}.
Return ONLY JSON.
`;

  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
  });

  return JSON.parse(res.choices[0].message.content);
}

/* ======================
   CRAWLER
====================== */
const crawler = new PlaywrightCrawler({
  proxyConfiguration,
  maxConcurrency: 1,
  requestHandlerTimeoutSecs: 180,

  async requestHandler({ page, request, log }) {
    log.info('Opening Google Maps');

    // Safe resource blocking (do NOT block stylesheets)
    await page.route('**/*', route => {
      const t = route.request().resourceType();
      if (['image', 'media', 'font'].includes(t)) route.abort();
      else route.continue();
    });

    await page.goto(request.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('div[role="feed"]');

    /* ======================
       SCROLL & LOAD CARDS
    ====================== */
    let previousCount = 0;
    let stableScrolls = 0;

    while (stableScrolls < 3) {
      const count = await page.$$eval(
        'a[href^="https://www.google.com/maps/place"]',
        els => els.length
      );

      if (count === previousCount) {
        stableScrolls++;
      } else {
        stableScrolls = 0;
        previousCount = count;
      }

      await page.evaluate(() =>
        document.querySelector('div[role="feed"]')?.scrollBy(0, 8000)
      );
      await sleep(800);
    }

    const cards = await page.$$('a[href^="https://www.google.com/maps/place"]');
    log.info(`Total cards loaded: ${cards.length}`);

    if (cards.length <= startIndex) {
      log.info('No new places left. Auto-stopping.');
      await Actor.setValue(STATE_KEY, { lastIndex: 0 });
      return;
    }

    const endIndex = Math.min(cards.length, startIndex + RESULTS_PER_RUN);
    let pushedThisRun = 0;

    /* ======================
       PROCESS BATCH
    ====================== */
    for (let i = startIndex; i < endIndex; i++) {
      try {
        const card = cards[i];
        if (!card) break;

        const prevTitle = await page.textContent('h1.DUwDvf').catch(() => null);
        await card.focus();
        await page.keyboard.press('Enter');

        await page.waitForFunction(
          prev =>
            document.querySelector('h1.DUwDvf') &&
            document.querySelector('h1.DUwDvf').textContent !== prev,
          prevTitle,
          { timeout: 10000 }
        );

        const data = await page.evaluate(() => {
          const pick = s => document.querySelector(s)?.textContent?.trim() || '';
          const href = s => document.querySelector(s)?.href || '';
          return {
            title: pick('h1.DUwDvf'),
            category: pick('button.DkEaL'),
            rating: pick('div.F7nice span[aria-hidden="true"]'),
            phone: pick('button[data-item-id*="phone"]'),
            website: href('a[data-item-id*="authority"]'),
            google_maps_link: location.href,
          };
        });

        if (!data.title) continue;

        const placeId = data.google_maps_link.split('?')[0];
        if (seen[placeId]) {
          continue; // dedup
        }

        data.industry = detectIndustry(data.category);
        data.sentiment = analyzeSentiment(data.rating);

        const pitches = await generatePitches(data);
        Object.assign(data, pitches);

        await Actor.pushData(data);

        // mark progress
        seen[placeId] = true;
        state.lastIndex = i + 1;
        pushedThisRun++;

        await Actor.setValue(SEEN_KEY, seen);
        await Actor.setValue(STATE_KEY, state);

        await sleep(500);
      } catch {
        log.warning(`Skipped index ${i}`);
      }
    }

    /* ======================
       AUTO-STOP LOGIC
    ====================== */
    if (pushedThisRun === 0) {
      log.info('No new unique places pushed in this run. Auto-stopping.');
      await Actor.setValue(STATE_KEY, { lastIndex: 0 });
    } else {
      log.info(`Pushed ${pushedThisRun} new places this run.`);
    }
  },
});

/* ======================
   RUN
====================== */
await crawler.run(startUrls);
await Actor.exit();
