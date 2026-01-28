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
  maxResults = 30,
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
const humanWait = async () => sleep(800 + Math.random() * 1200);

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
    whatsapp: `Hi ${data.title}, I came across your business on Google Maps. We help businesses grow using ${services.join(', ')}. Can we connect?`,
    email_subject: `Quick idea to grow ${data.title}`,
    email_body: `Hi ${data.title},

I noticed your business on Google Maps and wanted to share how we help similar businesses with ${services.join(', ')}.

Would you be open to a quick call?

Best regards`,
  };
}

/* ======================
   CRAWLER
====================== */
const crawler = new PlaywrightCrawler({
  proxyConfiguration,
  maxConcurrency: 1,
  navigationTimeoutSecs: 40,
  requestHandlerTimeoutSecs: 120,

  async requestHandler({ page, request, log }) {

    /* ======================
       SEARCH PAGE
    ====================== */
    if (!request.label) {
      log.info('Collecting Google Maps place URLs...');

      await page.goto(request.url, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('div[role="feed"]');

      const links = new Set();

      while (links.size < maxResults) {
        const newLinks = await page.$$eval(
          'a[href^="https://www.google.com/maps/place"]',
          els => els.map(e => e.href)
        );

        newLinks.forEach(l => links.add(l));
        if (newLinks.length === 0) break;

        await page.evaluate(() =>
          document.querySelector('div[role="feed"]')?.scrollBy(0, 8000)
        );

        await humanWait();
      }

      await crawler.addRequests(
        [...links].slice(0, maxResults).map(url => ({
          url,
          label: 'PLACE',
        }))
      );

      log.info(`Queued ${links.size} places`);
      return;
    }

    /* ======================
       PLACE PAGE
    ====================== */
    if (request.label === 'PLACE') {
      try {
        await page.goto(request.url, { waitUntil: 'domcontentloaded' });
        await humanWait();

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

        if (!data.title) return;

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
      } catch (err) {
        log.warning(`Skipped ${request.url}`);
      }
    }
  },
});

/* ======================
   RUN
====================== */
await crawler.run(startUrls);
await Actor.exit();
