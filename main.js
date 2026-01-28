import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import OpenAI from 'openai';

await Actor.init();

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

// 🔒 HARD LIMIT — intentional
const RESULTS_PER_RUN = 25;

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
      email_body: `Hi ${data.title},

We help similar businesses with ${services.join(', ')}.

Best regards`,
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

    // 🚀 Resource optimization (SAFE)
    await page.route('**/*', route => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    await page.goto(request.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('div[role="feed"]');

    /* ----------------------
       Load enough cards
    ---------------------- */
    for (let i = 0; i < 5; i++) {
      await page.evaluate(() =>
        document.querySelector('div[role="feed"]')?.scrollBy(0, 8000)
      );
      await sleep(800);
    }

    const cards = await page.$$('a[href^="https://www.google.com/maps/place"]');
    log.info(`Found ${cards.length} cards, extracting ${RESULTS_PER_RUN}`);

    /* ----------------------
       Process ONLY 25
    ---------------------- */
    for (let i = 0; i < Math.min(cards.length, RESULTS_PER_RUN); i++) {
      try {
        const prevTitle = await page.textContent('h1.DUwDvf').catch(() => null);
        await cards[i].click();

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

        data.industry = detectIndustry(data.category);
        data.sentiment = analyzeSentiment(data.rating);

        const pitches = await generatePitches(data);
        Object.assign(data, pitches);

        await Actor.pushData(data);
        await sleep(500);
      } catch {
        log.warning(`Skipped place ${i + 1}`);
      }
    }

    log.info('Batch completed safely — exiting run');
  },
});

/* ======================
   RUN
====================== */
await crawler.run(startUrls);
await Actor.exit();
