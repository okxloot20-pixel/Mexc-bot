import dotenv from "dotenv";

dotenv.config();

const botToken = process.env.TELEGRAM_BOT_TOKEN;

if (!botToken) {
  console.error("❌ TELEGRAM_BOT_TOKEN not found in environment variables");
  process.exit(1);
}

// You'll need to provide your actual Replit URL here
// Replace with your current Replit URL
const WEBHOOK_URL = process.argv[2] || "https://e78e0794-a7b9-4eb7-91fc-56aa86108949-00-7aa5pyjb3lka.worf.replit.dev/webhooks/telegram/action";

async function setupWebhook() {
  try {
    console.log(`🔧 Setting up Telegram webhook...`);
    console.log(`📍 Webhook URL: ${WEBHOOK_URL}`);

    const url = `https://api.telegram.org/bot${botToken}/setWebhook`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url: WEBHOOK_URL,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: false,
      }),
    });

    const data = (await response.json()) as any;

    if (data.ok) {
      console.log("✅ Webhook successfully set!");
      console.log(`📝 Webhook URL: ${WEBHOOK_URL}`);
      console.log(`📨 Allowed updates: message, callback_query`);
      
      // Get webhook info to confirm
      const infoUrl = `https://api.telegram.org/bot${botToken}/getWebhookInfo`;
      const infoResponse = await fetch(infoUrl);
      const infoData = (await infoResponse.json()) as any;
      
      if (infoData.ok && infoData.result) {
        console.log(`\n📋 Webhook Info:`);
        console.log(`   URL: ${infoData.result.url}`);
        console.log(`   Has custom certificate: ${infoData.result.has_custom_certificate}`);
        console.log(`   Pending update count: ${infoData.result.pending_update_count}`);
      }
    } else {
      console.error("❌ Failed to set webhook:");
      console.error(data.description || data);
    }
  } catch (error) {
    console.error("❌ Error setting webhook:", error);
    process.exit(1);
  }
}

setupWebhook();
