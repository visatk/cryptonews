import { XMLParser } from 'fast-xml-parser';

// --- Type Definitions ---
export interface Env {
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

// --- Global Constants (Loaded once per worker instance) ---
const FEEDS: Feed[] = [
  { id: "coindesk", name: "CoinDesk", rss: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { id: "cointelegraph", name: "Cointelegraph", rss: "https://cointelegraph.com/rss" },
  { id: "decrypt", name: "Decrypt", rss: "https://decrypt.co/feed" },
  { id: "the-block", name: "The Block", rss: "https://www.theblock.co/rss.xml" },
  { id: "bitcoin-magazine", name: "Bitcoin Magazine", rss: "https://bitcoinmagazine.com/feed" },
  { id: "bankless", name: "Bankless", rss: "https://www.bankless.com/rss/feed" },
  { id: "paradigm", name: "Paradigm Research", rss: "https://www.paradigm.xyz/rss.xml" },
  { id: "vitalik", name: "Vitalik Buterin", rss: "https://vitalik.eth.limo/feed.xml" },
  { id: "dl-news", name: "DL News", rss: "https://www.dlnews.com/arc/outboundfeeds/rss/" },
  { id: "bitcoin-com", name: "Bitcoin.com", rss: "https://news.bitcoin.com/feed/" },
  { id: "cryptopotato", name: "CryptoPotato", rss: "https://cryptopotato.com/feed/" },
  { id: "cryptobriefing", name: "Crypto Briefing", rss: "https://cryptobriefing.com/feed/" },
  { id: "newsbtc", name: "NewsBTC", rss: "https://www.newsbtc.com/feed/" },
  { id: "ambcrypto", name: "AMBCrypto", rss: "https://ambcrypto.com/feed/" },
  { id: "cryptoslate", name: "CryptoSlate", rss: "https://cryptoslate.com/feed/" }
];

const GREETINGS: string[] = [
  "Gm Crypto Fam! ☀️ Here's your daily dose of blockchain updates:",
  "Hello everyone! 👋 Catch up on the latest crypto market moves:",
  "Welcome to your daily crypto digest! 📊 Let's see what's making waves:",
  "Hey there! 🚀 Ready to dive into today's top web3 stories?"
];

const SIGN_OFFS: string[] = [
  "Stay tuned for more updates tomorrow. Keep building! 🛠️",
  "Trade safely and HODL strong! See you tomorrow. 💎🙌",
  "That wraps up today's edition. Stay curious! 🧠💡",
  "Stay informed, stay ahead. Catch you in the next update! ⚡"
];

// --- Main Worker Export ---
export default {
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(processNewsAndPost(env));
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }
    
    try {
      await processNewsAndPost(env);
      return new Response("Crypto news fetched and posted to Telegram successfully!", { status: 200 });
    } catch (error: any) {
      return new Response(`Error: ${error.message}`, { status: 500 });
    }
  }
} satisfies ExportedHandler<Env>;

// --- Core Business Logic ---

async function processNewsAndPost(env: Env): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHANNEL_ID) {
    console.error("CRITICAL: Missing Telegram secrets. Please set TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID.");
    return;
  }

  const parser = new XMLParser({
    ignoreAttributes: false, // Keep attributes to safely parse Atom links (e.g., <link href="...">)
    parseTagValue: true,
  });
  
  const newsItems: NewsItem[] = [];

  const fetchPromises = FEEDS.map(async (feed) => {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 7000);

    try {
      const response = await fetch(feed.rss, {
        signal: controller.signal,
        headers: {
          'User-Agent': 'CryptoNewsBot/2.0 (Cloudflare Worker)',
          'Accept': 'application/rss+xml, application/xml, text/xml'
        }
      });
      
      clearTimeout(timeoutId);

      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      
      const xmlData = await response.text();
      const result = parser.parse(xmlData);
      
      // Deep analysis: Handle RSS, Atom, and RDF safely
      let items: any = result?.rss?.channel?.item || result?.feed?.entry || result?.['rdf:RDF']?.item;
      
      if (items && !Array.isArray(items)) {
        items = [items];
      }

      if (items && items.length > 0) {
        const latestItem = items[0];
        
        let title = latestItem.title?.trim() || "";
        // Handle cases where title might be an object (e.g., <title type="text">...</title> in Atom)
        if (typeof title === 'object' && title['#text']) {
           title = title['#text'].trim();
        }

        let link = "";
        
        // Handle standard RSS <link>http...</link>
        if (typeof latestItem.link === 'string') {
          link = latestItem.link;
        } 
        // Handle Atom feed <link rel="alternate" href="..." />
        else if (Array.isArray(latestItem.link)) {
          const altLink = latestItem.link.find((l: any) => l['@_rel'] === "alternate" || !l['@_rel']);
          link = altLink ? altLink['@_href'] : (latestItem.link[0]?.['@_href'] || "");
        } 
        // Handle single Atom feed link object
        else if (latestItem.link && typeof latestItem.link === 'object') {
          link = latestItem.link['@_href'] || "";
        }

        if (title && link) {
          newsItems.push({
            source: feed.name,
            title: escapeHTML(title),
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
    console.log("No news fetched. Aborting Telegram post.");
    return;
  }

  // Limit to top 12 news
  const selectedNews = newsItems.slice(0, 12);
  const message = formatTelegramMessage(selectedNews);

  await sendToTelegram(env, message);
}

// --- Helper Functions ---

function escapeHTML(text: string): string {
  if (!text) return "";
  return text.toString()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTelegramMessage(newsItems: NewsItem[]): string {
  const randomGreeting = GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
  const randomSignOff = SIGN_OFFS[Math.floor(Math.random() * SIGN_OFFS.length)];

  const dateOptions: Intl.DateTimeFormatOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  const today = new Date().toLocaleDateString('en-US', dateOptions);

  let message = `━━━━━━━━━━━━━━━━━━━━\n`;
  message += `📰 <b>DAILY CRYPTO INTELLIGENCE</b>\n`;
  message += `📅 <i>${today}</i>\n`;
  message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
  
  message += `${randomGreeting}\n\n`;

  newsItems.forEach((item) => {
    message += `🔹 <b>${item.source}:</b> <a href="${item.link}">${item.title}</a>\n\n`;
  });

  message += `━━━━━━━━━━━━━━━━━━━━\n`;
  message += `<i>${randomSignOff}</i>\n`;
  message += `#CryptoNews #Bitcoin #Web3 #DailyDigest`;

  return message;
}

async function sendToTelegram(env: Env, message: string): Promise<void> {
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

  const result: any = await response.json();
  if (!result.ok) {
    console.error("Telegram API Error:", result.description);
    throw new Error(`Telegram API Error: ${result.description}`);
  } else {
    console.log("Successfully posted to Telegram!");
  }
}
