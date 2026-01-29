import { Actor } from 'apify';
import { PlaywrightCrawler, createPlaywrightRouter, Dataset, log } from 'crawlee';
import OpenAI from 'openai';

await Actor.init();

/* ======================
   INPUT & CONFIG
====================== */
const input = (await Actor.getInput()) || {};
const {
    startUrls = [],
    maxResults = 20,
    services = ['Web Design'],
    openaiApiKey,
    useProxy = true,
} = input;

const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

// Adjusted for Free Tier Proxy
const proxyConfiguration = useProxy
    ? await Actor.createProxyConfiguration({
        groups: ['DATACENTER'], // Free tier usually only has datacenter
    })
    : undefined;

/* ======================
   HELPERS
====================== */
function detectIndustry(text = '') {
    const t = text.toLowerCase();
    if (t.includes('restaurant') || t.includes('cafe')) return 'Hospitality';
    if (t.includes('clinic') || t.includes('doctor')) return 'Healthcare';
    if (t.includes('agency') || t.includes('consult')) return 'Agency';
    return t || 'Local Business';
}

function analyzeSentiment(rating) {
    const r = parseFloat(rating) || 0;
    if (r >= 4.0) return 'Positive';
    if (r >= 3.0) return 'Neutral';
    return 'Negative';
}

async function generatePitches(data) {
    if (!openai) {
        return {
            whatsapp: `Hi ${data.title}, we love your business! Can we help you with ${services[0]}?`,
            email_subject: `Helping ${data.title} grow`,
            email_body: `Hi ${data.title},\n\nWe specialize in ${services.join(', ')}. Let's chat!`
        };
    }
    try {
        const prompt = `Context: Cold Outreach. Business: "${data.title}". Industry: ${data.industry}. Services: ${services.join(', ')}. Output JSON: {whatsapp, email_subject, email_body}`;
        const res = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            response_format: { type: "json_object" }
        });
        return JSON.parse(res.choices[0].message.content);
    } catch (e) {
        return { whatsapp: "Error", email_subject: "Error", email_body: "Error" };
    }
}

/* ======================
   ROUTER
====================== */
const router = createPlaywrightRouter();

router.addDefaultHandler(async ({ page, enqueueLinks, request, log }) => {
    log.info(`Scraping search list: ${request.url}`);
    
    // Ensure we are on HTTPS
    if (request.url.startsWith('http://')) {
        const newUrl = request.url.replace('http://', 'https://');
        await page.goto(newUrl);
    }

    try {
        await page.waitForSelector('div[role="feed"]', { timeout: 30000 });
    } catch (e) {
        log.error('Feed not found. Google might be blocking Datacenter proxies.');
        return;
    }

    let itemsLoaded = 0;
    while (itemsLoaded < maxResults) {
        const links = await page.$$('a[href*="/maps/place/"]');
        itemsLoaded = links.length;
        if (itemsLoaded >= maxResults) break;

        await page.evaluate(() => document.querySelector('div[role="feed"]')?.scrollBy(0, 1000));
        await page.waitForTimeout(2000);
    }

    await enqueueLinks({
        selector: 'a[href*="/maps/place/"]',
        label: 'DETAIL',
        limit: maxResults,
    });
});

router.addHandler('DETAIL', async ({ page, request, log }) => {
    log.info(`Scraping place: ${request.url}`);
    await page.waitForSelector('h1', { timeout: 20000 });

    const data = await page.evaluate(() => {
        const getText = (s) => document.querySelector(s)?.innerText?.trim() || '';
        return {
            title: getText('h1'),
            rating: document.querySelector('span[role="img"][aria-label*="stars"]')?.getAttribute('aria-label')?.split(' ')[0] || '0',
            industry: getText('button[jsaction*="category"]'),
            address: getText('button[data-item-id="address"]'),
            website: document.querySelector('a[data-item-id="authority"]')?.href || '',
            phone: getText('button[data-item-id*="phone"]'),
            google_maps_url: window.location.href
        };
    });

    data.industry = detectIndustry(data.industry);
    data.sentiment = analyzeSentiment(data.rating);
    const pitches = await generatePitches(data);
    
    await Dataset.pushData({ ...data, ...pitches });
});

/* ======================
   CRAWLER START
====================== */
const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    requestHandler: router,
    maxConcurrency: 1, // Keep low for Free tier to avoid bans
    launchContext: {
        launchOptions: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--ignore-certificate-errors'
            ],
        },
    },
});

log.info('Starting Crawler...');
// Sanitize Start URLs to HTTPS before running
const sanitizedUrls = startUrls.map(u => {
    const urlStr = typeof u === 'string' ? u : u.url;
    return urlStr.replace('http://', 'https://');
});

await crawler.run(sanitizedUrls);
log.info('Crawler Finished.');
await Actor.exit();
