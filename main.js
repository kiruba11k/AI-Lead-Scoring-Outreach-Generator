import { Actor } from 'apify';
import { PlaywrightCrawler, createPlaywrightRouter, Dataset } from 'crawlee';
import OpenAI from 'openai';

// Initialize the Apify SDK
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

// Initialize OpenAI if key is present
const openai = openaiApiKey ? new OpenAI({ apiKey: openaiApiKey }) : null;

// Proxy Configuration (Essential for Google Maps)
const proxyConfiguration = useProxy
    ? await Actor.createProxyConfiguration({ groups: ['GOOGLE_SERP'] }) // Prefer GOOGLE_SERP proxies if available, otherwise auto
    : undefined;

/* ======================
   HELPER FUNCTIONS
====================== */

// Robust industry detector
function detectIndustry(text = '') {
    const t = text.toLowerCase();
    if (t.includes('restaurant') || t.includes('cafe') || t.includes('bar')) return 'Hospitality';
    if (t.includes('clinic') || t.includes('doctor') || t.includes('dental')) return 'Healthcare';
    if (t.includes('retail') || t.includes('store') || t.includes('shop')) return 'Retail';
    if (t.includes('agency') || t.includes('consult')) return 'Agency';
    return t || 'Local Business'; // Fallback to raw text if detected
}

// Sentiment analysis on rating
function analyzeSentiment(rating) {
    const r = parseFloat(rating) || 0;
    if (r >= 4.5) return 'Excellent';
    if (r >= 4.0) return 'Good';
    if (r >= 3.0) return 'Average';
    return 'Poor';
}

// OpenAI Pitch Generator
async function generatePitches(data) {
    // Fallback if no API key
    if (!openai) {
        return {
            whatsapp: `Hi ${data.title}, saw your high rating! We help businesses like yours with ${services[0]}. Chat?`,
            email_subject: `Growth idea for ${data.title}`,
            email_body: `Hi Team ${data.title},\n\nI see you're doing great in ${data.industry}. We help similar businesses optimize with ${services.join(', ')}.\n\nOpen to a chat?`
        };
    }

    // AI Prompt
    try {
        const prompt = `
        Context: B2B Cold Outreach.
        Prospect: "${data.title}" (Rating: ${data.rating}/5).
        Industry: ${data.industry}.
        Missing Website: ${!data.website}.
        
        My Services: ${services.join(', ')}.
        
        Task: Generate 3 JSON fields:
        1. 'whatsapp': A friendly, casual 1-sentence msg.
        2. 'email_subject': Catchy, non-spammy subject line.
        3. 'email_body': Professional 3-sentence value pitch.
        
        Output JSON only.
        `;

        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini',
            messages: [{ role: 'user', content: prompt }],
            temperature: 0.7,
            response_format: { type: "json_object" }
        });

        return JSON.parse(response.choices[0].message.content);
    } catch (e) {
        console.error('OpenAI Error:', e.message);
        return { whatsapp: "Error generating pitch", email_subject: "Error", email_body: "Error" };
    }
}

/* ======================
   ROUTER & SCRAPER LOGIC
====================== */
const router = createPlaywrightRouter();

// ROUTE 1: The Search List (Scrolls and finds links)
router.addDefaultHandler(async ({ page, enqueueLinks, log }) => {
    log.info(`Processing Search List: ${page.url()}`);

    // Wait for the feed to appear
    try {
        await page.waitForSelector('div[role="feed"]', { timeout: 20000 });
    } catch(e) {
        log.warning('Could not find feed. Check if the URL is a valid Google Maps Search URL.');
        return;
    }

    // Scroll Loop to load items
    let previousHeight = 0;
    let sameHeightCount = 0;
    
    while (true) {
        // Find all loaded links so far
        const linkElements = await page.$$('a[href*="/maps/place/"]');
        log.info(`Found ${linkElements.length} places so far...`);

        if (linkElements.length >= maxResults) break;

        // Scroll logic
        await page.evaluate(() => {
            const feed = document.querySelector('div[role="feed"]');
            if(feed) feed.scrollBy(0, feed.scrollHeight);
        });
        await new Promise(r => setTimeout(r, 2000)); // Wait for network load

        // Check if we hit bottom
        const currentHeight = await page.evaluate(() => document.querySelector('div[role="feed"]')?.scrollHeight);
        if (currentHeight === previousHeight) {
            sameHeightCount++;
            if (sameHeightCount > 3) break; // Stop if no new content after 3 tries
        } else {
            sameHeightCount = 0;
        }
        previousHeight = currentHeight;
    }

    // Enqueue the found links with the label 'DETAIL'
    log.info(`Enqueueing links for detailed scraping...`);
    await enqueueLinks({
        selector: 'a[href*="/maps/place/"]',
        label: 'DETAIL',
        transformRequestFunction: (req) => {
            // Keep only the first 'maxResults'
            // (Note: This is a loose limit, strict limiting is harder in parallel scrapes)
            return req; 
        }
    });
});

// ROUTE 2: The Detail Page (Scrapes 1 business)
router.addHandler('DETAIL', async ({ page, request, log }) => {
    log.info(`Scraping Details: ${request.url}`);

    // Wait for the main header (Name of place)
    // We use generic selectors to avoid "DUwDvf" style breaking
    try {
        await page.waitForSelector('h1', { timeout: 15000 });
    } catch(e) {
        log.error(`Timeout waiting for page load: ${request.url}`);
        return;
    }

    const data = await page.evaluate(() => {
        const getText = (s) => document.querySelector(s)?.innerText?.trim() || '';
        const getAttr = (s, a) => document.querySelector(s)?.getAttribute(a) || '';
        
        // Robust Selectors based on ARIA labels and data attributes
        const title = getText('h1');
        const ratingStr = getAttr('span[role="img"][aria-label*="stars"]', 'aria-label') || '';
        const rating = ratingStr.split(' ')[0] || '0';
        
        // Industry usually appears just below the title in a button
        const industry = getText('button[jsaction*="category"]');
        
        // Address often in a button with data-item-id="address"
        const address = getText('button[data-item-id="address"]');
        
        // Website
        const website = getAttr('a[data-item-id="authority"]', 'href') || '';
        
        // Phone
        const phone = getText('button[data-item-id*="phone"]');

        return {
            title,
            rating,
            industry,
            address,
            website,
            phone,
            google_maps_url: window.location.href
        };
    });

    // Post-processing
    data.has_website = !!data.website;
    data.has_phone = !!data.phone;
    data.industry = detectIndustry(data.industry);
    data.sentiment = analyzeSentiment(data.rating);

    // Generate AI Content
    log.info(`Generating pitch for ${data.title}...`);
    const pitches = await generatePitches(data);
    
    const finalResult = { ...data, ...pitches };

    // Save to Apify Dataset
    await Dataset.pushData(finalResult);
});

/* ======================
   CRAWLER CONFIG
====================== */
const crawler = new PlaywrightCrawler({
    proxyConfiguration,
    requestHandler: router,
    // Limit concurrency to prevent memory overload
    maxConcurrency: 2, 
    // Browser config
    launchContext: {
        launchOptions: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
        }
    },
    // Fail safe
    failedRequestHandler: ({ request, log }) => {
        log.error(`Request ${request.url} failed too many times.`);
    },
});

/* ======================
   EXECUTION
====================== */
log.info('Starting Crawler...');
await crawler.run(startUrls);
log.info('Crawler Finished.');
await Actor.exit();
