import { XMLParser } from 'fast-xml-parser';

// --- Type Definitions ---
export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHANNEL_ID: string;
  AI: any; // Cloudflare Workers AI Binding
}

interface Feed {
  id: string;
  name: string;
  rss: string;
}

interface NewsItem {
  source: string;
  title: string;
  link: string;
}

// --- Global Constants ---
const FEEDS: Feed[] = [
  { id: "coindesk", name: "CoinDesk", rss: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { id: "cointelegraph", name: "Cointelegraph", rss: "https://cointelegraph.com/rss" },
  { id: "decrypt", name: "Decrypt", rss: "https://decrypt.co/feed" },
  { id: "the-block", name: "The Block", rss: "https://www.theblock.co/rss.xml" }
];

// --- Main Worker Export ---
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    let selectedFeeds: Feed[] = [];

    // Multiple Cron Trigger Logic
    if (event.cron === "0 6 * * *") {
      // Day Time Run (6:00 AM UTC / 12 PM BD Time)
      console.log("Running Day Schedule...");
      selectedFeeds = [FEEDS[0], FEEDS[1]]; // CoinDesk & Cointelegraph
    } else if (event.cron === "0 18 * * *") {
      // Night Time Run (6:00 PM UTC / 12 AM BD Time)
      console.log("Running Night Schedule...");
      selectedFeeds = [FEEDS[2], FEEDS[3]]; // Decrypt & The Block
    } else {
      // Fallback
      selectedFeeds = [FEEDS[0], FEEDS[1]];
    }

    ctx.waitUntil(processNewsAndPost(env, selectedFeeds, event.cron));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }
    
    try {
      // For manual browser testing, we process the first 2 feeds
      await processNewsAndPost(env, [FEEDS[0], FEEDS[1]], "manual-trigger");
      return new Response("Crypto news fetched, processed by AI, and posted successfully!", { status: 200 });
    } catch (error: any) {
      return new Response(`Error: ${error.message}`, { status: 500 });
    }
  }
} satisfies ExportedHandler<Env>;

// --- Core Business Logic ---

async function processNewsAndPost(env: Env, activeFeeds: Feed[], schedulePrefix: string): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHANNEL_ID) {
    console.error("CRITICAL: Missing Telegram secrets.");
    return;
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: true,
  });
  
  const newsItems: NewsItem[] = [];

  // Fetch only the selected 2 feeds
  const fetchPromises = activeFeeds.map(async (feed) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 7000);

    try {
      const response = await fetch(feed.rss, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'CryptoNewsBot/3.0 (Cloudflare Worker AI)',
          'Accept': 'application/rss+xml, application/xml, text/xml'
        }
      });
      
      clearTimeout(timeoutId);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      const xmlData = await response.text();
      const result = parser.parse(xmlData);
      
      let items: any = result?.rss?.channel?.item || result?.feed?.entry || result?.['rdf:RDF']?.item;
      
      if (items && !Array.isArray(items)) {
        items = [items];
      }

      // Get the single latest news from this feed
      if (items && items.length > 0) {
        const latestItem = items[0];
        
        let title = latestItem.title?.trim() || "";
        if (typeof title === 'object' && title['#text']) {
           title = title['#text'].trim();
        }

        let link = "";
        if (typeof latestItem.link === 'string') {
          link = latestItem.link;
        } else if (Array.isArray(latestItem.link)) {
          const altLink = latestItem.link.find((l: any) => l['@_rel'] === "alternate" || !l['@_rel']);
          link = altLink ? altLink['@_href'] : (latestItem.link[0]?.['@_href'] || "");
        } else if (latestItem.link && typeof latestItem.link === 'object') {
          link = latestItem.link['@_href'] || "";
        }

        if (title && link) {
          newsItems.push({
            source: feed.name,
            title: title,
            link: link
          });
        }
      }
    } catch (error: any) {
      console.error(`Failed to fetch/parse ${feed.name}:`, error.message);
    } finally {
      clearTimeout(timeoutId);
    }
  });

  await Promise.allSettled(fetchPromises);

  if (newsItems.length === 0) {
    console.log("No news fetched. Aborting.");
    return;
  }

  // --- AI GENERATION ---
  let aiGeneratedMessage = "";
  
  const rawNewsText = newsItems.map(item => `Source: ${item.source}\nTitle: ${item.title}\nLink: ${item.link}`).join('\n\n');
  
  const aiPrompt = `
    You are an expert Crypto News Journalist for a Telegram channel.
    I will provide you with 2 latest crypto news items.
    Write a highly engaging, short Telegram post summarizing them in English.
    
    Rules:
    1. Start with a catchy header (e.g., 📰 DAILY CRYPTO INTEL or 🌙 NIGHTLY CRYPTO INTEL).
    2. Write 1-2 short sentences summarizing the significance of these updates.
    3. List the news clearly using the exact links provided formatted as: <a href="LINK">Title</a>
    4. MUST use valid Telegram HTML tags ONLY (<b>, <i>, <a>, <u>). Do not use Markdown (** or *).
    5. Add relevant emojis and 3-4 hashtags at the end.
    6. Output ONLY the final message content. No conversational intro like "Here is your post:".

    Raw News Data:
    ${rawNewsText}
  `;

  try {
    const aiResponse = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
      messages: [
        { role: 'system', content: 'You are a professional, direct Telegram bot. Output only the requested HTML message.' },
        { role: 'user', content: aiPrompt }
      ]
    });
    
    aiGeneratedMessage = aiResponse.response;
  } catch (error: any) {
    console.error("AI Generation Error:", error.message);
    return; // Abort if AI fails
  }

  await sendToTelegram(env, aiGeneratedMessage);
}

// --- Helper Functions ---

async function sendToTelegram(env: Env, message: string): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHANNEL_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: false // Allowed preview so one of the 2 news links shows a nice thumbnail
    })
  });

  const result: any = await response.json();
  if (!result.ok) {
    console.error("Telegram API Error:", result.description);
    throw new Error(`Telegram API Error: ${result.description}`);
  } else {
    console.log("Successfully posted AI-generated content to Telegram!");
  }
}
