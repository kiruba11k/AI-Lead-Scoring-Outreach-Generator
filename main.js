import { Actor } from 'apify';
import { PlaywrightCrawler, createPlaywrightRouter, Dataset, log } from 'crawlee';
import Groq from 'groq-sdk';

await Actor.init();

/* ======================
   INPUT
====================== */
const input = (await Actor.getInput()) || {};

const {
    startUrls = [],
    maxResults = 25,
    services = ['Web Design'],
    groqApiKey,
    useProxy = true,
} = input;

/* ======================
   GROQ CLIENT
====================== */
const groq = groqApiKey ? new Groq({ apiKey: groqApiKey }) : null;

/* ======================
   PROXY
====================== */
const proxyConfiguration = useProxy
    ? await Actor.createProxyConfiguration({ useApifyProxy: true })
    : undefined;

/* ======================
   AI HELPER
====================== */
async function generatePitches(data) {
    if (!groq) {
        return {
            whatsapp: "Hi!",
            email_subject: "Hello",
            email_body: "Let's connect."
        };
    }

    try {
        const res = await groq.chat.completions.create({
            model: "llama-3.1-8b-instant", // FAST & CHEAP
            temperature: 0.7,
            max_tokens: 300,
            messages: [
                {
                    role: "system",
                    content: "You are a B2B sales copywriter. Respond ONLY in valid JSON."
                },
                {
                    role: "user",
                    content: `
Create a personalized sales pitch for ${services.join(', ')}.

Business Name: ${data.title}
Industry: ${data.industry}

Return ONLY valid JSON in this format:
{
  "whatsapp": "...",
  "email_subject": "...",
  "email_body": "..."
}
`
                }
            ]
        });

        const text = res.choices[0]?.message?.content || "{}";

        // SAFETY: Ensure valid JSON
        const jsonStart = text.indexOf('{');
        const jsonEnd = text.lastIndexOf('}');
        if (jsonStart === -1 || jsonEnd === -1) return {};

        return JSON.parse(text.slice(jsonStart, jsonEnd + 1));
    } catch (err) {
        log.error("Groq pitch generation failed", err);
        return {};
    }
}

/* ======================
   ROUTER
====================== */
const router = createPlaywrightRouter();

/* -------- SEARCH LIST -------- */
router.addDefaultHandler(async ({ page, enqueueLinks, log }) => {
    log.info('Opening Google Maps search results...');
    await page.waitForSelector('div[role="feed"]', { timeout: 30000 });

    let linksFound = 0;
    let staleCount = 0;

    while (linksFound < maxResults) {
        const links = await page.$$('a[href*="/maps/place/"]');

        if (links.length === linksFound) staleCount++;
        else {
            staleCount = 0;
            linksFound = links.length;
            log.info(`Found ${linksFound}/${maxResults} listings`);
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
    log.info(`Scraping: ${request.url}`);
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
    await Dataset.pushData({ ...data, ...pitches });
});

/* ======================
   CRAWLER
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
                    'googleads', 'analytics'
                ],
            });
        },
    ],
});

/* ======================
   RUN
====================== */
log.info('Starting crawler...');
await crawler.run(startUrls);
log.info('Crawler finished.');
await Actor.exit();
