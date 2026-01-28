import { Actor } from 'apify';
import { PlaywrightCrawler } from 'crawlee';
import OpenAI from 'openai';

await Actor.init();
const input = await Actor.getInput() || {};

const {
  startUrls,
  maxResults = 30,
  businessGoal = 'Web Design',
  openaiApiKey,
  useProxy = true,
} = input;

const openai = openaiApiKey
  ? new OpenAI({ apiKey: openaiApiKey })
  : null;

const proxyConfiguration = useProxy
  ? await Actor.createProxyConfiguration({ useApifyProxy: true })
  : undefined;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const humanWait = async () => sleep(800 + Math.random() * 1200);

// ======================
// AI OUTREACH GENERATOR
// ======================
async function generatePitches(data) {
  if (!openai) return fallbackPitches(data);

  const prompt = `
You are a sales outreach expert.

Business name: ${data.title}
Category: ${data.category}
Rating: ${data.rating}
Has website: ${data.has_website}
Service offered: ${businessGoal}

Generate:
1. WhatsApp message (friendly, short)
2. Cold email subject
3. Cold email body

Return ONLY valid JSON with keys:
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

// ======================
// FALLBACK (NO OPENAI)
// ======================
function fallbackPitches(data) {
  return {
    whatsapp: `Hi ${data.title}, I came across your business on Google Maps. We help businesses grow using ${businessGoal}. Can we connect?`,
    email_subject: `Quick idea to grow ${data.title}`,
    email_body: `Hi ${data.title},

I noticed your business on Google Maps and wanted to share how we help similar businesses with ${businessGoal}.

Would you be open to a quick call?

Best regards`,
  };
}

// ======================
// CRAWLER
// ======================
const crawler = new PlaywrightCrawler({
  proxyConfiguration,
  maxRequestsPerCrawl: 1,

  async requestHandler({ page, request, log }) {
    log.info(`Scraping leads from: ${request.url}`);

    await page.goto(request.url, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('div[role="feed"]');

    const links = new Set();

    while (links.size < maxResults) {
      const newLinks = await page.$$eval(
        'a[href^="https://www.google.com/maps/place"]',
        (els) => els.map((e) => e.href)
      );

      newLinks.forEach((l) => links.add(l));
      if (newLinks.length === 0) break;

      await page.evaluate(() => {
        document.querySelector('div[role="feed"]')?.scrollBy(0, 10000);
      });

      await humanWait();
    }

    for (const url of [...links].slice(0, maxResults)) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await humanWait();

        const data = await page.evaluate(() => {
          const pick = (s) => document.querySelector(s)?.textContent?.trim() || '';
          const href = (s) => document.querySelector(s)?.href || '';

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
      } catch {
        log.warning(`Skipped ${url}`);
      }
    }
  },
});

await crawler.run(startUrls);
await Actor.exit();
