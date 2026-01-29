import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import OpenAI from 'openai';

await Actor.init();

/* ======================
   INPUT
====================== */
const input = (await Actor.getInput()) || {};
const {
  startUrls,
  maxResults = 25, // Free tier safe limit
  services = ['Web Design'],
  tone = 'friendly',
  language = 'English',
  openaiApiKey,
  useProxy = true,
} = input;

/* ======================
   STATE & DEDUP
====================== */
const SEEN_KEY = 'SEEN_PLACES';
const seen = (await Actor.getValue(SEEN_KEY)) || {};

/* ======================
   OPENAI
====================== */
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

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
      whatsapp: `Hi ${data.title}, we help businesses grow using ${services.join(', ')}. Can we connect?`,
      email_subject: `Quick idea for ${data.title}`,
      email_body: `Hi ${data.title},\n\nWe help businesses with ${services.join(', ')}. Would you be open to a short call?\n`,
    };
  }

  const prompt = `
You are a sales outreach expert.

Business: ${data.title}
Industry: ${data.industry}
Rating: ${data.rating}
Sentiment: ${data.sentiment}
Has website: ${data.has_website}

Services: ${services.join(', ')}

Write concise outreach.
Return ONLY JSON with:
whatsapp, email_subject, email_body
`;

  const res = await openai.chat.completions.create({
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.7,
  });

  return JSON.parse(res.choices[0].message.content);
}

/* ======================
   CRAWLER
====================== */
const crawler = new PlaywrightCrawler({
  proxyConfiguration,
  maxConcurrency: 1,
  navigationTimeoutSecs: 60,
  requestHandlerTimeoutSecs: 300,

  async requestHandler({ page, request, log }) {
    log.info('Opening Google Maps search');

    // Block heavy assets
    await page.route('**/*', route => {
      const t = route.request().resourceType();
      if (['image', 'media', 'font'].includes(t)) route.abort();
      else route.continue();
    });

    await page.goto(request.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('div[role="feed"]');
    await sleep(2000);

    // Scroll to load more cards
    await page.evaluate(() => {
      const feed = document.querySelector('div[role="feed"]');
      feed.scrollBy(0, feed.scrollHeight);
    });
    await sleep(2000);

    const cards = await page.$$('div[role="article"]');
    log.info(`Cards loaded: ${cards.length}`);

    let extracted = 0;

    for (let i = 0; i < cards.length && extracted < maxResults; i++) {
      try {
        const freshCards = await page.$$('div[role="article"]');
        const card = freshCards[i];
        if (!card) break;

        // ✅ STABLE UNIQUE KEY
        const placeLink = await card.$eval(
          'a[href*="/maps/place"]',
          el => el.href
        );

        if (seen[placeLink]) continue;

        // Click card
        await card.click();
        await page.waitForSelector('h1.DUwDvf', { timeout: 15000 });
        await sleep(1000);

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

        if (!data.title) throw new Error('Panel not loaded');

        data.has_website = Boolean(data.website);
        data.has_phone = Boolean(data.phone);
        data.industry = detectIndustry(data.category);
        data.sentiment = analyzeSentiment(data.rating);

        const pitches = await generatePitches(data);
        Object.assign(data, pitches);

        await Actor.pushData(data);

        seen[placeLink] = true;
        extracted++;

        await Actor.setValue(SEEN_KEY, seen);
        log.info(`Extracted ${extracted}: ${data.title}`);

        // Go back to list
        await page.keyboard.press('Escape');
        await sleep(800);

      } catch (err) {
        log.warning(`Skipped index ${i}: ${err.message}`);
      }
    }

    log.info(`Run completed with ${extracted} results`);
  },
});

/* ======================
   RUN
====================== */
await crawler.run(startUrls);
await Actor.exit();
