import { XMLParser } from 'fast-xml-parser';

export interface Env {
  AI: any;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_CHANNEL_ID: string;
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

// Feeds mapped for different times of the day
const DAY_FEEDS: Feed[] = [
  { id: "coindesk", name: "CoinDesk", rss: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { id: "cointelegraph", name: "Cointelegraph", rss: "https://cointelegraph.com/rss" }
];

const NIGHT_FEEDS: Feed[] = [
  { id: "decrypt", name: "Decrypt", rss: "https://decrypt.co/feed" },
  { id: "the-block", name: "The Block", rss: "https://www.theblock.co/rss.xml" }
];

export default {
  // Handles automatic scheduled events based on wrangler.toml crons
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    let feedsToProcess: Feed[] = [];
    let timeOfDay = "Day";

    if (event.cron === "0 6 * * *") {
      feedsToProcess = DAY_FEEDS;
      timeOfDay = "Morning";
    } else if (event.cron === "0 18 * * *") {
      feedsToProcess = NIGHT_FEEDS;
      timeOfDay = "Evening";
    } else {
      feedsToProcess = DAY_FEEDS; // Fallback
    }

    ctx.waitUntil(processNewsAndPost(feedsToProcess, timeOfDay, env));
  },

  // Handles manual HTTP requests for testing
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }

    // You can test day vs night by passing a URL query: ?time=night
    const url = new URL(request.url);
    const isNight = url.searchParams.get("time") === "night";
    
    const feedsToProcess = isNight ? NIGHT_FEEDS : DAY_FEEDS;
    const timeOfDay = isNight ? "Evening" : "Morning";

    try {
      await processNewsAndPost(feedsToProcess, timeOfDay, env);
      return new Response(`Successfully fetched, generated via AI, and posted ${timeOfDay} news!`, { status: 200 });
    } catch (error: any) {
      return new Response(`Error: ${error.message}`, { status: 500 });
    }
  }
};

/**
 * Main function to fetch feeds, ask AI to format them, and post to Telegram
 */
async function processNewsAndPost(feeds: Feed[], timeOfDay: string, env: Env): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHANNEL_ID) {
    console.error("Missing Telegram secrets in Cloudflare Environment.");
    return;
  }

  const parser = new XMLParser({
    ignoreAttributes: false,
    parseTagValue: true,
  });

  let rawNewsItems: NewsItem[] = [];

  // Concurrently fetch feeds
  const fetchPromises = feeds.map(async (feed) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 7000); // 7s timeout

    try {
      const response = await fetch(feed.rss, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AI-Crypto-Bot',
          'Accept': 'application/rss+xml, application/xml, text/xml'
        }
      });
      
      clearTimeout(timeoutId);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      const xmlData = await response.text();
      const result = parser.parse(xmlData);
      
      // Support standard RSS & Atom feeds
      let items = result?.rss?.channel?.item || result?.feed?.entry || result?.['rdf:RDF']?.item;
      
      if (items && !Array.isArray(items)) {
        items = [items];
      }

      // Grab top 2 news items per feed to give AI enough context
      if (items && items.length > 0) {
        for (let i = 0; i < Math.min(2, items.length); i++) {
          const item = items[i];
          let title = item.title?.trim() || "";
          let link = item.link?.href || item.link || "";

          if (Array.isArray(item.link)) {
            const altLink = item.link.find((l: any) => l['@_rel'] === "alternate");
            link = altLink ? altLink['@_href'] : item.link[0]?.['@_href'] || link;
          } else if (typeof item.link === 'object' && item.link['@_href']) {
            link = item.link['@_href'];
          }

          if (title && link) {
            rawNewsItems.push({ source: feed.name, title, link: typeof link === 'string' ? link : link.toString() });
          }
        }
      }
    } catch (error: any) {
      console.error(`Failed to fetch ${feed.name}:`, error.message);
    } finally {
      clearTimeout(timeoutId);
    }
  });

  await Promise.allSettled(fetchPromises);

  if (rawNewsItems.length === 0) {
    console.log("No news fetched. Aborting.");
    return;
  }

  // Generate Telegram Message using Workers AI
  const message = await generateTelegramPostWithAI(rawNewsItems, timeOfDay, env);
  
  if (message) {
    await sendToTelegram(message, env);
  }
}

/**
 * Uses Cloudflare Workers AI (Llama 3) to generate a formatted Telegram post
 */
async function generateTelegramPostWithAI(news: NewsItem[], timeOfDay: string, env: Env): Promise<string | null> {
  const newsListString = news.map((n, i) => `${i + 1}. Source: ${n.source}\nTitle: ${n.title}\nLink: ${n.link}`).join('\n\n');

  const systemPrompt = `You are a highly skilled Crypto News Journalist managing a Telegram channel.
Your task is to create a professional, engaging ${timeOfDay} news summary.

CRITICAL RULES FOR TELEGRAM:
1. ONLY use Telegram HTML tags: <b>bold</b>, <i>italic</i>, and <a href="URL">text</a>.
2. NEVER use Markdown (**bold** or [text](url)). Telegram will reject the message if you use markdown.
3. Keep the output strictly in English.
4. Format structure:
   - Catchy Header with Emojis (e.g., 🌅 Morning Crypto Update!)
   - A short introductory sentence.
   - Bullet points for the news. Summarize the title nicely and hyperlink the text using the provided link. Format: 🔸 <b>Source:</b> <a href="URL">Summarized Title</a>
   - A brief concluding sentence.
   - Relevant hashtags (#Crypto #Web3).
   
Do not include any other text outside the generated post.`;

  try {
    const aiResponse = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: `Here is the raw data:\n${newsListString}` }
      ],
      temperature: 0.6,
      max_tokens: 500
    });

    return aiResponse.response;
  } catch (error: any) {
    console.error("AI Generation Error:", error.message);
    
    // Fallback message if AI fails
    let fallbackMessage = `<b>📰 ${timeOfDay} Crypto Updates</b>\n\n`;
    news.forEach(n => {
      fallbackMessage += `🔸 <b>${n.source}:</b> <a href="${n.link}">${escapeHTML(n.title)}</a>\n\n`;
    });
    fallbackMessage += `#Crypto #Blockchain`;
    return fallbackMessage;
  }
}

/**
 * Sends the formatted HTML message to the Telegram channel
 */
async function sendToTelegram(message: string, env: Env): Promise<void> {
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: env.TELEGRAM_CHANNEL_ID,
      text: message,
      parse_mode: 'HTML',
      disable_web_page_preview: true
    })
  });

  const result = (await response.json()) as any;
  if (!result.ok) {
    console.error("Telegram API Error Details:", JSON.stringify(result));
    throw new Error(`Telegram Error: ${result.description}`);
  } else {
    console.log(`Successfully posted ${result.result.message_id} to Telegram!`);
  }
}

/**
 * Helper to escape HTML characters (used primarily in the fallback)
 */
function escapeHTML(text: string): string {
  if (!text) return "";
  return text.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
