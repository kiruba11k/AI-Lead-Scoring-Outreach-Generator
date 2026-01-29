import { Actor } from 'apify';
import { PlaywrightCrawler, createPlaywrightRouter, Dataset, log } from 'crawlee';
import OpenAI from 'openai';

await Actor.init();

const input = (await Actor.getInput()) || {};
const {
    startUrls = [],
    maxResults = 25, 
    services = ['Web Design'],
    openaiApiKey,
    useProxy = true,
} = input;

const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

const proxyConfiguration = useProxy
    ? await Actor.createProxyConfiguration({ useApifyProxy: true })
    : undefined;

/* ======================
   AI & HELPERS
====================== */
async function generatePitches(data) {
    if (!openai) return { whatsapp: "Hi!", email_subject: "Hello", email_body: "Let's connect." };
    try {
        const res = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: `Pitch ${services.join(', ')} to ${data.title}. Return JSON {whatsapp, email_subject, email_body}` }],
            response_format: { type: "json_object" }
        });
        return JSON.parse(res.choices[0].message.content);
    } catch (e) { return {}; }
}

/* ======================
   ROUTER
====================== */
const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ page, enqueueLinks, log }) => {
    log.info('Opening Search List...');
    await page.waitForSelector('div[role="feed"]', { timeout: 30000 });

    let linksFound = 0;
    let staleCount = 0;
    
    while (linksFound < maxResults) {
        const links = await page.$$('a[href*="/maps/place/"]');
        if (links.length === linksFound) staleCount++;
        else {
            staleCount = 0;
            linksFound = links.length;
            log.info(`Found ${linksFound}/${maxResults} links...`);
        }
        if (linksFound >= maxResults || staleCount > 5) break;

        await page.evaluate(() => document.querySelector('div[role="feed"]')?.scrollBy(0, 1500));
        await page.waitForTimeout(2500); 
    }

    await enqueueLinks({
        selector: 'a[href*="/maps/place/"]',
        label: 'DETAIL',
        limit: maxResults, // This ensures we only add what you asked for
    });
});

router.addHandler('DETAIL', async ({ page, request, log }) => {
    log.info(`Scraping Details: ${request.url}`);
    await page.waitForSelector('h1', { timeout: 20000 });

    const data = await page.evaluate(() => {
        const pick = s => document.querySelector(s)?.textContent?.trim() || '';
        return {
            title: pick('h1'),
            rating: document.querySelector('span[role="img"][aria-label*="stars"]')?.getAttribute('aria-label')?.split(' ')[0] || '0',
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
   CRAWLER (Optimized for Speed)
====================== */
/* ======================
   CRAWLER (Fixed & Optimized)
====================== */
const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    requestHandler: router,
    maxConcurrency: 1, 
    // This is the correct way to ensure it stops after the list + detail pages
    maxRequestsPerCrawl: maxResults + 5, 
    launchContext: {
        launchOptions: {
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
        },
    },
    // Speed Boost: Block images and styles to save time/credits
    preNavigationHooks: [
        async ({ blockRequests }) => {
            await blockRequests({
                urlPatterns: ['.jpg', '.jpeg', '.png', '.svg', '.gif', '.webp', '.css', '.woff', 'googleads', 'analytics'],
            });
        },
    ],
});

log.info('Starting Crawler...');
await crawler.run(startUrls);
log.info('Crawler Finished. Stopping Actor.');
await Actor.exit();
