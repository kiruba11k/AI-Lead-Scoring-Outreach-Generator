import { Actor } from 'apify';
import { PlaywrightCrawler, createPlaywrightRouter, Dataset, log } from 'crawlee';
import Groq from 'groq-sdk';

await Actor.init();

/* ======================
   1. INPUT & CONFIG
====================== */
const input = (await Actor.getInput()) || {};
const {
    startUrls = [],
    maxResults = 30,
    services = ['Web Design'],
    tone = 'friendly',
    language = 'English',
    groqApiKey,
    useProxy = true,
} = input;

/* ======================
   2. GROQ CLIENT
====================== */
const groq = groqApiKey ? new Groq({ apiKey: groqApiKey }) : null;

/* ======================
   3. PROXY
====================== */
const proxyConfiguration = useProxy
    ? await Actor.createProxyConfiguration({ useApifyProxy: true })
    : undefined;

/* ======================
   4. AI HELPER (BEST VERSION)
====================== */
async function generatePitches(data) {
    if (!groq) {
        return {
            whatsapp: 'Hi!',
            email_subject: 'Hello',
            email_body: "Let's connect.",
        };
    }

    try {
        const res = await groq.chat.completions.create({
            model: 'llama-3.1-8b-instant',
            temperature: 0.7,
            max_tokens: 350,
            messages: [
                {
                    role: 'system',
                    content: `You are a world-class B2B sales copywriter.
Target Language: ${language}.
Tone: ${tone}.
Respond ONLY in valid JSON.`,
                },
                {
                    role: 'user',
                    content: `
Create a personalized sales pitch for ${services.join(', ')}.

Business Name: ${data.title}
Industry: ${data.industry}
Rating: ${data.rating}

Return ONLY valid JSON:
{
  "whatsapp": "short text with emojis",
  "email_subject": "catchy subject",
  "email_body": "persuasive email body"
}
`,
                },
            ],
        });

        const text = res.choices[0]?.message?.content || '{}';

        // SAFETY: extract JSON only
        const start = text.indexOf('{');
        const end = text.lastIndexOf('}');
        if (start === -1 || end === -1) return {};

        return JSON.parse(text.slice(start, end + 1));
    } catch (err) {
        log.error('Groq generation failed', err);
        return {};
    }
}

/* ======================
   5. ROUTER
====================== */
const router = createPlaywrightRouter();

/* -------- SEARCH PAGE -------- */
router.addDefaultHandler(async ({ page, enqueueLinks, log }) => {
    log.info('🚀 Searching Google Maps...');
    await page.waitForSelector('div[role="feed"]', { timeout: 30000 });

    let linksFound = 0;
    let staleCount = 0;

    while (linksFound < maxResults) {
        const links = await page.$$('a[href*="/maps/place/"]');

        if (links.length === linksFound) staleCount++;
        else {
            staleCount = 0;
            linksFound = links.length;
            log.info(`Found ${linksFound}/${maxResults}`);
        }

        if (linksFound >= maxResults || staleCount > 5) break;

        await page.evaluate(() => {
            document.querySelector('div[role="feed"]')?.scrollBy(0, 1500);
        });

        await page.waitForTimeout(2500);
    }

    await enqueueLinks({
        selector: 'a[href*="/maps/place/"]',
        label: 'DETAIL',
        limit: maxResults,
    });
});

/* -------- DETAIL PAGE -------- */
router.addHandler('DETAIL', async ({ page, request, log }) => {
    log.info(`🔍 Scraping: ${request.url}`);
    await page.waitForSelector('h1', { timeout: 20000 });

    const data = await page.evaluate(() => {
        const pick = sel => document.querySelector(sel)?.textContent?.trim() || '';
        return {
            title: pick('h1'),
            rating:
                document
                    .querySelector('span[role="img"][aria-label*="stars"]')
                    ?.getAttribute('aria-label')
                    ?.split(' ')[0] || '0',
            industry: pick('button[jsaction*="category"]'),
            phone: pick('button[data-item-id*="phone"]'),
            website: document.querySelector('a[data-item-id*="authority"]')?.href || '',
            google_maps_link: window.location.href,
        };
    });

    const pitches = await generatePitches(data);

    // ✅ PPE BILLING EVENT
    await Dataset.pushData({ ...data, ...pitches }, 'dataset-item');
});

/* ======================
   6. CRAWLER
====================== */
const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    requestHandler: router,
    maxConcurrency: 1,
    maxRequestsPerCrawl: maxResults + 5,
    launchContext: {
        launchOptions: {
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
        },
    },
    preNavigationHooks: [
        async ({ blockRequests }) => {
            await blockRequests({
                urlPatterns: [
                    '.jpg', '.jpeg', '.png', '.svg',
                    '.gif', '.webp', '.css',
                    '.woff', '.woff2',
                    'googleads', 'analytics',
                ],
            });
        },
    ],
});

/* ======================
   7. RUN
====================== */
log.info('Starting crawler...');
await crawler.run(startUrls);
log.info('Crawler finished.');
await Actor.exit();
