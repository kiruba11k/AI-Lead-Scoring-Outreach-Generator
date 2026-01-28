import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import OpenAI from 'openai';

await Actor.init();

const input = await Actor.getInput() || {};
const {
  startUrls,
  maxResults = 100,
  services = ['Web Design'],
  tone = 'friendly',
  language = 'English',
  openaiApiKey,
  useProxy = true,
} = input;

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
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const humanWait = async () => sleep(500 + Math.random() * 600);

function detectIndustry(category = '') {
  const c = category.toLowerCase();
  if (c.includes('restaurant') || c.includes('cafe')) return 'restaurant';
  if (c.includes('clinic') || c.includes('hospital') || c.includes('dental')) return 'healthcare';
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

function toneInstruction(tone) {
  if (tone === 'formal') return 'Use professional and polite language.';
  if (tone === 'aggressive') return 'Use confident, direct, sales-driven language.';
  return 'Use friendly and conversational language.';
}

function languageInstruction(language) {
  if (language === 'Hindi') return 'Write the message in simple Hindi.';
  if (language === 'Tamil') return 'Write the message in simple Tamil.';
  return 'Write the message in English.';
}

/* ======================
   AI PITCH GENERATOR
====================== */
async function generatePitches(data) {
  if (!openai) {
    return {
      whatsapp: `Hi ${data.title}, we help businesses grow using ${services.join(', ')}. Can we connect?`,
      email_subject: `Quick idea for ${data.title}`,
      email_body: `Hi ${data.title},\n\nWe help similar businesses with ${services.join(', ')}.\n\nBest regards`,
    };
  }

  const prompt = `
You are an expert sales outreach AI.

Business name: ${data.title}
Industry: ${data.industry}
Category: ${data.category}
Rating: ${data.rating}
Sentiment: ${data.sentiment}
Has website: ${data.has_website}

Services offered: ${services.join(', ')}

${toneInstruction(tone)}
${languageInstruction(language)}

Generate:
1) WhatsApp message
2) Cold email subject
3) Cold email body

Return ONLY valid JSON with:
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
  navigationTimeoutSecs: 40,
  requestHandlerTimeoutSecs: 240,

  async requestHandler({ page, request, log }) {
    log.info('Opening Google Maps (SPA mode)');

    /* ----------------------
       RESOURCE OPTIMIZATION
       (DO NOT block stylesheets)
    ---------------------- */
    await page.route('**/*', route => {
      const type = route.request().resourceType();
      if (['image', 'media', 'font'].includes(type)) {
        route.abort();
      } else {
        route.continue();
      }
    });

    /* ----------------------
       LOAD SEARCH PAGE
    ---------------------- */
    await page.goto(request.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('div[role="feed"]');

    /* ----------------------
       SCROLL TO LOAD RESULTS
    ---------------------- */
    let loaded = 0;
    while (loaded < maxResults) {
      loaded = await page.$$eval(
        'a[href^="https://www.google.com/maps/place"]',
        els => els.length
      );

      await page.evaluate(() => {
        document.querySelector('div[role="feed"]')?.scrollBy(0, 8000);
      });

      await humanWait();
    }

    log.info(`Loaded ${loaded} places`);

    /* ----------------------
       CLICK CARDS (SPA SAFE)
    ---------------------- */
    for (let i = 0; i < maxResults; i++) {
      try {
        const cards = await page.$$('a[href^="https://www.google.com/maps/place"]');
        if (!cards[i]) break;

        const prevTitle = await page
          .textContent('h1.DUwDvf')
          .catch(() => null);

        await cards[i].click();

        // Wait until panel actually changes
        await page.waitForFunction(
          prev => {
            const h = document.querySelector('h1.DUwDvf');
            return h && h.textContent !== prev;
          },
          prevTitle,
          { timeout: 15000 }
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

        data.has_website = Boolean(data.website);
        data.has_phone = Boolean(data.phone);
        data.industry = detectIndustry(data.category);
        data.sentiment = analyzeSentiment(data.rating);

        const pitches = await generatePitches(data);

        data.whatsapp_message = pitches.whatsapp;
        data.email_subject = pitches.email_subject;
        data.email_body = pitches.email_body;

        await Actor.pushData(data);
        await sleep(500);
      } catch {
        log.warning('Skipped one place');
      }
    }
  },
});

/* ======================
   RUN
====================== */
await crawler.run(startUrls);
await Actor.exit();
