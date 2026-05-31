import { XMLParser } from 'fast-xml-parser';

export default {
  async scheduled(event, env, ctx) {
    // Keep the worker alive until the process finishes
    ctx.waitUntil(this.processNewsAndPost(env));
  },

  async fetch(request, env, ctx) {
    // Allows manual triggering via browser for testing
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405 });
    }
    
    try {
      await this.processNewsAndPost(env);
      return new Response("Crypto news fetched and posted to Telegram successfully!", { status: 200 });
    } catch (error) {
      return new Response(`Error: ${error.message}`, { status: 500 });
    }
  },

  async processNewsAndPost(env) {
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHANNEL_ID) {
      console.error("Missing Telegram secrets. Please set TELEGRAM_BOT_TOKEN and TELEGRAM_CHANNEL_ID.");
      return;
    }

    const feeds = [
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

    const parser = new XMLParser({
      ignoreAttributes: true,
      parseTagValue: true,
    });
    
    let newsItems = [];

    // Fetch all feeds concurrently with a 7-second timeout to prevent worker execution limits
    const fetchPromises = feeds.map(async (feed) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 7000);

      try {
        const response = await fetch(feed.rss, {
          signal: controller.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'application/rss+xml, application/xml, text/xml'
          }
        });
        
        clearTimeout(timeoutId);

        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        const xmlData = await response.text();
        const result = parser.parse(xmlData);
        
        // Deep analysis: Handle different XML structures (RSS vs Atom vs RDF)
        let items = result?.rss?.channel?.item || result?.feed?.entry || result?.['rdf:RDF']?.item;
        
        // Ensure items is an array (fast-xml-parser returns an object if there's only one child)
        if (items && !Array.isArray(items)) {
          items = [items];
        }

        if (items && items.length > 0) {
          const latestItem = items[0];
          let title = latestItem.title?.trim() || "";
          let link = latestItem.link?.href || latestItem.link || "";

          // Fix Atom feed link variations
          if (Array.isArray(latestItem.link)) {
            link = latestItem.link.find(l => l.rel === "alternate")?.href || latestItem.link[0]?.href || "";
          }

          if (title && link) {
            newsItems.push({
              source: feed.name,
              title: this.escapeHTML(title),
              link: link
            });
          }
        }
      } catch (error) {
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

    // Limit to top 12 news to keep the Telegram post clean and readable
    const selectedNews = newsItems.slice(0, 12);
    const message = this.formatTelegramMessage(selectedNews);

    await this.sendToTelegram(env, message);
  },

  // Helper function: Crucial for preventing Telegram API 400 Bad Request errors
  escapeHTML(text) {
    if (!text) return "";
    return text.toString()
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  },

  formatTelegramMessage(newsItems) {
    // Humanized greetings and sign-offs for dynamic posting
    const greetings = [
      "Gm Crypto Fam! ☀️ Here's your daily dose of blockchain updates:",
      "Hello everyone! 👋 Catch up on the latest crypto market moves:",
      "Welcome to your daily crypto digest! 📊 Let's see what's making waves:",
      "Hey there! 🚀 Ready to dive into today's top web3 stories?"
    ];

    const signOffs = [
      "Stay tuned for more updates tomorrow. Keep building! 🛠️",
      "Trade safely and HODL strong! See you tomorrow. 💎🙌",
      "That wraps up today's edition. Stay curious! 🧠💡",
      "Stay informed, stay ahead. Catch you in the next update! ⚡"
    ];

    const randomGreeting = greetings[Math.floor(Math.random() * greetings.length)];
    const randomSignOff = signOffs[Math.floor(Math.random() * signOffs.length)];

    const dateOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
    const today = new Date().toLocaleDateString('en-US', dateOptions);

    let message = `━━━━━━━━━━━━━━━━━━━━\n`;
    message += `📰 <b>DAILY CRYPTO INTELLIGENCE</b>\n`;
    message += `📅 <i>${today}</i>\n`;
    message += `━━━━━━━━━━━━━━━━━━━━\n\n`;
    
    message += `${randomGreeting}\n\n`;

    newsItems.forEach((item) => {
      // Hyperlinking the title directly saves space and looks premium
      message += `🔹 <b>${item.source}:</b> <a href="${item.link}">${item.title}</a>\n\n`;
    });

    message += `━━━━━━━━━━━━━━━━━━━━\n`;
    message += `<i>${randomSignOff}</i>\n`;
    message += `#CryptoNews #Bitcoin #Web3 #DailyDigest`;

    return message;
  },

  async sendToTelegram(env, message) {
    const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHANNEL_ID,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: true // Essential to prevent large thumbnail spam
      })
    });

    const result = await response.json();
    if (!result.ok) {
      console.error("Telegram API Error:", result.description);
      throw new Error(`Telegram API Error: ${result.description}`);
    } else {
      console.log("Successfully posted to Telegram!");
    }
  }
};
