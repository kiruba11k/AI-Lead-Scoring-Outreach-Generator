import { Actor } from 'apify';
import { PlaywrightCrawler, createPlaywrightRouter, Dataset, log } from 'crawlee';
import OpenAI from 'openai';

await Actor.init();

/* ======================
   INPUT
====================== */
const input = (await Actor.getInput()) || {};
const {
    startUrls = [],
    maxResults = 25,
    services = ['Web Design'],
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
   PROXY (Reverted to your working config)
====================== */
const proxyConfiguration = useProxy
    ? await Actor.createProxyConfiguration({ useApifyProxy: true })
    : undefined;

/* ======================
   HELPERS
====================== */
function detectIndustry(category = '') {
    const c = category.toLowerCase();
    if (c.includes('restaurant') || c.includes('cafe')) return 'hospitality';
    if (c.includes('clinic') || c.includes('hospital')) return 'healthcare';
    if (c.includes('agency') || c.includes('marketing')) return 'agency';
    return 'local_business';
}

function analyzeSentiment(rating) {
    const r = parseFloat(rating) || 0;
    if (r >= 4.2) return 'positive';
    if (r >= 3.5) return 'neutral';
    return 'negative';
}

async function generatePitches(data) {
    if (!openai) {
        return {
            whatsapp: `Hi ${data.title}, we help businesses grow using ${services.join(', ')}. Can we connect?`,
            email_subject: `Quick idea for ${data.title}`,
            email_body: `Hi ${data.title},\n\nWe help businesses with ${services.join(', ')}.`,
        };
    }
    try {
        const prompt = `Business: ${data.title}. Industry: ${data.industry}. Rating: ${data.rating}. Services: ${services.join(', ')}. Return JSON: whatsapp, email_subject, email_body`;
        const res = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: "json_object" }
        });
        return JSON.parse(res.choices[0].message.content);
    } catch (e) {
        return { whatsapp: "Check out our services!", email_subject: "Hello", email_body: "Hi" };
    }
}

/* ======================
   CRAWLER & ROUTER
====================== */
const router = createPlaywrightRouter();

// 1. Search List Handler
router.addDefaultHandler(async ({ page, enqueueLinks, log }) => {
    log.info('Processing Search List...');
    
    await page.waitForSelector('div[role="feed"]', { timeout: 30000 });

    let linksFound = 0;
    while (linksFound < maxResults) {
        const links = await page.$$('a[href*="/maps/place/"]');
        linksFound = links.length;
        if (linksFound >= maxResults) break;

        await page.evaluate(() => document.querySelector('div[role="feed"]')?.scrollBy(0, 1500));
        await page.waitForTimeout(2000);
    }

    await enqueueLinks({
        selector: 'a[href*="/maps/place/"]',
        label: 'DETAIL',
        limit: maxResults,
    });
});

// 2. Individual Place Handler
router.addHandler('DETAIL', async ({ page, request, log }) => {
    if (seen[request.url]) {
        log.info(`Skipping already seen: ${request.url}`);
        return;
    }

    log.info(`Scraping: ${request.url}`);
    await page.waitForSelector('h1', { timeout: 15000 });

    const data = await page.evaluate(() => {
        const pick = s => document.querySelector(s)?.textContent?.trim() || '';
        const href = s => document.querySelector(s)?.href || '';
        return {
            title: pick('h1'),
            category: pick('button[jsaction*="category"]'),
            rating: document.querySelector('span[role="img"][aria-label*="stars"]')?.getAttribute('aria-label')?.split(' ')[0] || '0',
            phone: pick('button[data-item-id*="phone"]'),
            website: href('a[data-item-id*="authority"]'),
            google_maps_link: window.location.href,
        };
    });

    data.has_website = !!data.website;
    data.has_phone = !!data.phone;
    data.industry = detectIndustry(data.category);
    data.sentiment = analyzeSentiment(data.rating);

    const pitches = await generatePitches(data);
    const finalResult = { ...data, ...pitches };

    await Dataset.pushData(finalResult);
    
    // Update local state and Apify storage
    seen[request.url] = true;
    await Actor.setValue(SEEN_KEY, seen);
});

/* ======================
   RUN
====================== */
const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    requestHandler: router,
    maxConcurrency: 1, // Stay safe on Free Tier
    launchContext: {
        launchOptions: {
            args: ['--no-sandbox', '--disable-dev-shm-usage'],
        },
    },
});

log.info('Starting Crawler...');
await crawler.run(startUrls);
log.info('Crawler Finished.');
await Actor.exit();
