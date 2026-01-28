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
const humanWait = async () => sleep(500 + Math.random() * 700);

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
  if (!openai) return fallbackPitches(data);

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

  try {
    const res = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.7,
    });

    return JSON.parse(res.choices[0].message.content);
  } catch {
    return fallbackPitches(data);
  }
}

function fallbackPitches(data) {
  return {
    whatsapp: `Hi ${data.title}, I found your business on Google Maps. We help businesses grow using ${services.join(', ')}. Can we connect?`,
    email_subject: `Quick growth idea for ${data.title}`,
    email_body: `Hi ${data.title},

I noticed your business on Google Maps and wanted to share how we help similar businesses with ${services.join(', ')}.

Would you be open to a quick chat?

Best regards`,
  };
}

/* ======================
   CRAWLER (SPA MODE)
====================== */
const crawler = new PlaywrightCrawler({
  proxyConfiguration,
  maxConcurrency: 1,
  navigationTimeoutSecs: 40,
  requestHandlerTimeoutSecs: 300,

  preNavigationHooks: [
    async ({ page }) => {
      // 🚀 MASSIVE CPU + MEMORY OPTIMIZATION
      await page.route('**/*', route => {
        const type = route.request().resourceType();
        if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
          route.abort();
        } else {
          route.continue();
        }
      });
    },
  ],

  async requestHandler({ page, request, log }) {
    log.info('Opening Google Maps (SPA mode)');

    /* ======================
       LOAD MAPS ONCE
    ====================== */
    await page.goto(request.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('div[role="feed"]');

    // Disable animations
    await page.addStyleTag({
      content: `* { animation: none !important; transition: none !important; }`,
    });

    /* ======================
       SCROLL RESULTS
    ====================== */
    const collected = new Set();
    let stableScrolls = 0;

    while (collected.size < maxResults && stableScrolls < 5) {
      const links = await page.$$eval(
        'a[href^="https://www.google.com/maps/place"]',
        els => els.map(e => e.href)
      );

      const before = collected.size;
      links.forEach(l => collected.add(l));
      stableScrolls = collected.size === before ? stableScrolls + 1 : 0;

      await page.evaluate(() =>
        document.querySelector('div[role="feed"]')?.scrollBy(0, 8000)
      );

      await sleep(800);
    }

    log.info(`Loaded ${collected.size} places`);

    /* ======================
       CLICK & EXTRACT (NO NAVIGATION)
    ====================== */
    const cards = await page.$$(
      'a[href^="https://www.google.com/maps/place"]'
    );

    for (let i = 0; i < Math.min(cards.length, maxResults); i++) {
      try {
        await cards[i].click();
        await page.waitForSelector('h1.DUwDvf', { timeout: 10000 });

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

        data.lead_score =
          (!data.website ? 40 : 0) +
          (!data.phone ? 20 : 0) +
          (Number(data.rating) > 0 && Number(data.rating) < 3.5 ? 30 : 0);

        data.priority =
          data.lead_score >= 60 ? 'High' :
          data.lead_score >= 40 ? 'Medium' : 'Low';

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
