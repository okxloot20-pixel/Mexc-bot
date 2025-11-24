import type { ContentfulStatusCode } from "hono/utils/http-status";

import { registerApiRoute } from "../mastra/inngest";
import { Mastra } from "@mastra/core";

if (!process.env.TELEGRAM_BOT_TOKEN) {
  console.warn(
    "Trying to initialize Telegram triggers without TELEGRAM_BOT_TOKEN. Can you confirm that the Telegram integration is configured correctly?",
  );
}

export type TriggerInfoTelegramOnNewMessage = {
  type: "telegram/message";
  params: {
    userName: string;
    message: string;
    telegramUserId: string;
    chatId: number;
  };
  payload: any;
};

export function registerTelegramTrigger({
  triggerType,
  handler,
}: {
  triggerType: string;
  handler: (
    mastra: Mastra,
    triggerInfo: TriggerInfoTelegramOnNewMessage,
  ) => Promise<void>;
}) {
  return [
    registerApiRoute("/webhooks/telegram/action", {
      method: "POST",
      handler: async (c) => {
        const mastra = c.get("mastra");
        const logger = mastra.getLogger();
        try {
          const payload = await c.req.json();

          logger?.info("📝 [Telegram] payload", payload);

          // Handle both text messages and callback_query (button clicks)
          let userName = "unknown";
          let message = "";
          let telegramUserId = "";
          let chatId = 0;

          if (payload.message) {
            // Text message
            userName = payload.message?.from?.username || "unknown";
            message = payload.message?.text || "";
            telegramUserId = String(payload.message?.from?.id || "");
            chatId = Number(payload.message?.chat?.id || 0);
            logger?.debug("📨 Processing text message");
          } else if (payload.callback_query) {
            // Button click
            userName = payload.callback_query?.from?.username || "unknown";
            message = payload.callback_query?.data || "";
            telegramUserId = String(payload.callback_query?.from?.id || "");
            chatId = Number(payload.callback_query?.message?.chat?.id || 0);
            logger?.debug("📨 Processing callback_query (button click):", { data: message });
          }

          if (message && telegramUserId) {
            await handler(mastra, {
              type: triggerType,
              params: {
                userName,
                message,
                telegramUserId,
                chatId,
              },
              payload,
            } as TriggerInfoTelegramOnNewMessage);
          }

          return c.text("OK", 200);
        } catch (error) {
          logger?.error("Error handling Telegram webhook:", error);
          return c.text("Internal Server Error", 500);
        }
      },
    }),
  ];
}
