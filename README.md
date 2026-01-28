# AI Lead Scoring & Outreach Generator (Google Maps)

This Apify Actor extracts business leads from Google Maps, scores them, and generates personalized outreach messages using AI.

It is designed for **stability, scalability, and real-world usage**, especially when working with Google Maps, which is a heavy single-page application (SPA).

---

## Key Features

- Scrapes business listings from Google Maps search results
- Extracts business details:
  - Name
  - Category
  - Rating
  - Phone number
  - Website
  - Google Maps URL
- Automatically enriches data with:
  - Industry classification
  - Review sentiment (positive / neutral / negative)
- Scores leads based on conversion potential
- Generates AI-powered outreach:
  - WhatsApp message
  - Cold email subject
  - Cold email body
- Supports multiple services in one run (Web Design, SEO, Marketing, etc.)
- Tone selection (friendly, formal, aggressive)
- Multi-language outreach support
- Optimized for Apify Free Tier and higher plans

---

## Execution Model (Important)

Google Maps is a resource-intensive SPA that continuously consumes memory as more places are opened.  
To guarantee reliable execution across all Apify plans, this actor follows a **batch-based execution model**.

### Default Behavior (Free Tier Safe)

- Extracts **25 businesses per run**
- Ensures:
  - No memory crashes
  - No timeouts
  - Always produces output

This is an intentional design choice for stability.

---

### Collecting All Places

To collect all businesses from a search:

1. Run the actor multiple times with the same Google Maps search URL
2. Each run appends results to the dataset
3. Over multiple runs, you can collect hundreds or thousands of places safely

This is the recommended and standard approach for scraping large Google Maps result sets.

---

### Paid Plans

Users with higher memory limits can:
- Increase the per-run extraction count
- Collect more places in fewer runs

Memory availability, not code logic, determines how many places can be safely processed in one run.

---

## Input Parameters

| Field | Description |
|-----|------------|
| startUrls | Google Maps search URL |
| services | Services to pitch (multiple allowed) |
| tone | Outreach tone (friendly / formal / aggressive) |
| language | Outreach language |
| openaiApiKey | Optional, enables AI-generated outreach |
| useProxy | Enable Apify Proxy |

---

## Output

Each extracted business produces a structured record including:

- Business details
- Lead score
- Industry and sentiment
- Outreach messages (WhatsApp and Email)

All results are saved to the Apify dataset.

---

## Recommended Use Cases

- Web design agencies
- SEO and local SEO providers
- Digital marketing agencies
- Sales teams and consultants
- CRM and lead generation pipelines

---

## Notes

- This actor is designed for production use
- Partial extraction per run is intentional and expected
- Stability and data quality are prioritized over aggressive scraping

---

