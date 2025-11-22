import { Mastra } from "@mastra/core";
import { MastraError } from "@mastra/core/error";
import { PinoLogger } from "@mastra/loggers";
import { LogLevel, MastraLogger } from "@mastra/core/logger";
import pino from "pino";
import { MCPServer } from "@mastra/mcp";
import { NonRetriableError } from "inngest";
import { z } from "zod";

import { sharedPostgresStorage } from "./storage";
import { inngest, inngestServe } from "./inngest";
import { telegramTradingWorkflow } from "./workflows/telegramTradingWorkflow";
import { mexcTradingAgent, parseAndExecuteCommand } from "./agents/mexcTradingAgent";
import { registerTelegramTrigger } from "../triggers/telegramTriggers";

class ProductionPinoLogger extends MastraLogger {
  protected logger: pino.Logger;

  constructor(
    options: {
      name?: string;
      level?: LogLevel;
    } = {},
  ) {
    super(options);

    this.logger = pino({
      name: options.name || "app",
      level: options.level || LogLevel.INFO,
      base: {},
      formatters: {
        level: (label: string, _number: number) => ({
          level: label,
        }),
      },
      timestamp: () => `,"time":"${new Date(Date.now()).toISOString()}"`,
    });
  }

  debug(message: string, args: Record<string, any> = {}): void {
    this.logger.debug(args, message);
  }

  info(message: string, args: Record<string, any> = {}): void {
    this.logger.info(args, message);
  }

  warn(message: string, args: Record<string, any> = {}): void {
    this.logger.warn(args, message);
  }

  error(message: string, args: Record<string, any> = {}): void {
    this.logger.error(args, message);
  }
}

export const mastra = new Mastra({
  storage: sharedPostgresStorage,
  // Register your workflows here
  workflows: {
    telegramTradingWorkflow,
  },
  // Register your agents here
  agents: {
    mexcTradingAgent,
  },
  mcpServers: {
    allTools: new MCPServer({
      name: "allTools",
      version: "1.0.0",
      tools: {},
    }),
  },
  bundler: {
    // A few dependencies are not properly picked up by
    // the bundler if they are not added directly to the
    // entrypoint.
    externals: [
      "@slack/web-api",
      "inngest",
      "inngest/hono",
      "hono",
      "hono/streaming",
    ],
    // sourcemaps are good for debugging.
    sourcemap: true,
  },
  server: {
    host: "0.0.0.0",
    port: 5000,
    middleware: [
      async (c, next) => {
        const mastra = c.get("mastra");
        const logger = mastra?.getLogger();
        logger?.debug("[Request]", { method: c.req.method, url: c.req.url });
        try {
          await next();
        } catch (error) {
          logger?.error("[Response]", {
            method: c.req.method,
            url: c.req.url,
            error,
          });
          if (error instanceof MastraError) {
            if (error.id === "AGENT_MEMORY_MISSING_RESOURCE_ID") {
              // This is typically a non-retirable error. It means that the request was not
              // setup correctly to pass in the necessary parameters.
              throw new NonRetriableError(error.message, { cause: error });
            }
          } else if (error instanceof z.ZodError) {
            // Validation errors are never retriable.
            throw new NonRetriableError(error.message, { cause: error });
          }

          throw error;
        }
      },
    ],
    apiRoutes: [
      // ======================================================================
      // Inngest Integration Endpoint
      // ======================================================================
      // This API route is used to register the Mastra workflow (inngest function) on the inngest server
      {
        path: "/api/inngest",
        method: "ALL",
        createHandler: async ({ mastra }) => inngestServe({ mastra, inngest }),
        // The inngestServe function integrates Mastra workflows with Inngest by:
        // 1. Creating Inngest functions for each workflow with unique IDs (workflow.${workflowId})
        // 2. Setting up event handlers that:
        //    - Generate unique run IDs for each workflow execution
        //    - Create an InngestExecutionEngine to manage step execution
        //    - Handle workflow state persistence and real-time updates
        // 3. Establishing a publish-subscribe system for real-time monitoring
        //    through the workflow:${workflowId}:${runId} channel
      },

      // ======================================================================
      // Connector Webhook Triggers
      // ======================================================================
      // Register your connector webhook handlers here using the spread operator.
      // Each connector trigger should be defined in src/triggers/{connectorName}Triggers.ts
      //
      // PATTERN FOR ADDING A NEW CONNECTOR TRIGGER:
      //
      // 1. Create a trigger file: src/triggers/{connectorName}Triggers.ts
      //    (See src/triggers/exampleConnectorTrigger.ts for a complete example)
      //
      // 2. Create a workflow: src/mastra/workflows/{connectorName}Workflow.ts
      //    (See src/mastra/workflows/linearIssueWorkflow.ts for an example)
      //
      // 3. Import both in this file:
      //    ```typescript
      //    import { register{ConnectorName}Trigger } from "../triggers/{connectorName}Triggers";
      //    import { {connectorName}Workflow } from "./workflows/{connectorName}Workflow";
      //    ```
      //
      // 4. Register the trigger in the apiRoutes array below:
      //    ```typescript
      //    ...register{ConnectorName}Trigger({
      //      triggerType: "{connector}/{event.type}",
      //      handler: async (mastra, triggerInfo) => {
      //        const logger = mastra.getLogger();
      //        logger?.info("🎯 [{Connector} Trigger] Processing {event}", {
      //          // Log relevant fields from triggerInfo.params
      //        });
      //
      //        // Create a unique thread ID for this event
      //        const threadId = `{connector}-{event}-${triggerInfo.params.someUniqueId}`;
      //
      //        // Start the workflow
      //        const run = await {connectorName}Workflow.createRunAsync();
      //        return await run.start({
      //          inputData: {
      //            threadId,
      //            ...triggerInfo.params,
      //          },
      //        });
      //      }
      //    })
      //    ```
      //
      // ======================================================================
      // EXAMPLE: Linear Issue Creation Webhook
      // ======================================================================
      // Uncomment to enable Linear webhook integration:
      //
      // ...registerLinearTrigger({
      //   triggerType: "linear/issue.created",
      //   handler: async (mastra, triggerInfo) => {
      //     // Extract what you need from the full payload
      //     const data = triggerInfo.payload?.data || {};
      //     const title = data.title || "Untitled";
      //
      //     // Start your workflow
      //     const run = await exampleWorkflow.createRunAsync();
      //     return await run.start({
      //       inputData: {
      //         message: `Linear Issue: ${title}`,
      //         includeAnalysis: true,
      //       }
      //     });
      //   }
      // }),
      //
      // To activate:
      // 1. Uncomment the code above
      // 2. Import at the top: import { registerLinearTrigger } from "../triggers/exampleConnectorTrigger";
      //
      // ======================================================================

      // ======================================================================
      // DIRECT Telegram Webhook - Fast Response
      // ======================================================================
      // Simple direct endpoint for Telegram messages - no workflow delays
      {
        path: "/webhooks/telegram/action",
        method: "POST",
        createHandler: async () => {
          return async (c: any) => {
            const mastra = c.get("mastra");
            const logger = mastra?.getLogger();
            
            try {
              const payload = await c.req.json();
              
              console.log("🔍 [TELEGRAM WEBHOOK RECEIVED]", JSON.stringify(payload));
              logger?.debug("🔍 [Telegram] Full payload received", JSON.stringify(payload, null, 2));

              // Handle callback query (button clicks)
              if (payload.callback_query) {
                const callbackData = payload.callback_query.data;
                const userId = String(payload.callback_query.from.id);
                const chatId = payload.callback_query.message.chat.id;
                const messageId = payload.callback_query.message.message_id;
                
                console.log(`🔘 Callback: "${callbackData}", UserID: ${userId}`);
                logger?.info("🔘 [Telegram] Callback query", { callbackData, userId, chatId });
                
                // Generate response based on callback
                let response = "";
                if (callbackData === "trading") {
                  response = JSON.stringify({
                    type: "menu",
                    text: "📈 *Трейдинг*",
                    keyboard: [
                      [
                        { text: "🟢 LONG лимит", callback_data: "long_limit" },
                        { text: "🔴 SHORT лимит", callback_data: "short_limit" }
                      ],
                      [
                        { text: "🟢 LONG маркет", callback_data: "long_market" },
                        { text: "🔴 SHORT маркет", callback_data: "short_market" }
                      ],
                      [
                        { text: "❌ Закрыть позицию", callback_data: "close_position" }
                      ],
                      [
                        { text: "← Назад", callback_data: "back_to_main" }
                      ]
                    ]
                  });
                } else if (callbackData === "positions") {
                  response = "💼 Открытые позиции\n\nОтправь: /positions";
                } else if (callbackData === "account") {
                  response = JSON.stringify({
                    type: "menu",
                    text: "👤 *Аккаунт*",
                    keyboard: [
                      [
                        { text: "📋 Регистрация", callback_data: "register" },
                        { text: "📊 Мои аккаунты", callback_data: "my_accounts" }
                      ],
                      [
                        { text: "💰 Баланс", callback_data: "balance" }
                      ],
                      [
                        { text: "← Назад", callback_data: "back_to_main" }
                      ]
                    ]
                  });
                } else if (callbackData === "orders") {
                  response = "📦 Управление ордерами\n\nОтправь: /orders";
                } else if (callbackData === "subscription") {
                  response = "🎯 *Подписка*\n\nФункция в разработке";
                } else if (callbackData === "signals") {
                  response = "🚨 *Сигналы*\n\nФункция в разработке";
                } else if (callbackData === "settings") {
                  response = "⚙️ *Настройки*\n\nФункция в разработке";
                } else if (callbackData === "help") {
                  response = "ℹ️ *Справка*\n\nОтправь: /help";
                } else if (callbackData === "back_to_main") {
                  response = JSON.stringify({
                    type: "menu",
                    text: "🤖 *Mexc Futures Trading Bot*",
                    keyboard: [
                      [
                        { text: "📈 Трейдинг", callback_data: "trading" },
                        { text: "📊 Позиции", callback_data: "positions" }
                      ],
                      [
                        { text: "👤 Аккаунт", callback_data: "account" },
                        { text: "📦 Ордеры", callback_data: "orders" }
                      ],
                      [
                        { text: "🎯 Подписка", callback_data: "subscription" }
                      ],
                      [
                        { text: "🚨 Сигналы", callback_data: "signals" },
                        { text: "⚙️ Настройки", callback_data: "settings" },
                        { text: "ℹ️ Help", callback_data: "help" }
                      ]
                    ]
                  });
                } else if (callbackData.startsWith("toggle_account_")) {
                  // Handle account toggle via callback
                  const { db } = require("../storage/db");
                  const { mexcAccounts } = require("../storage/schema");
                  const { eq, and } = require("drizzle-orm");
                  
                  const accountNumber = parseInt(callbackData.split("_")[2]);
                  
                  // Get current account status
                  const account = await db.query.mexcAccounts.findFirst({
                    where: and(
                      eq(mexcAccounts.telegramUserId, userId),
                      eq(mexcAccounts.accountNumber, accountNumber)
                    ),
                  });
                  
                  if (!account) {
                    response = `❌ Аккаунт #${accountNumber} не найден`;
                  } else {
                    // Send the current status so toggle will work correctly
                    const statusPrefix = account.isActive ? "✅" : "❌";
                    const simulatedMessage = `${statusPrefix} ${accountNumber}`;
                    response = await parseAndExecuteCommand(simulatedMessage, userId, mastra);
                  }
                } else {
                  response = "📨 Неизвестная команда";
                }
                
                // Edit message with new content
                if (process.env.TELEGRAM_BOT_TOKEN) {
                  const botToken = process.env.TELEGRAM_BOT_TOKEN;
                  const apiUrl = `https://api.telegram.org/bot${botToken}/editMessageText`;
                  
                  let editPayload: any = {
                    chat_id: chatId,
                    message_id: messageId,
                    text: response,
                    parse_mode: "Markdown",
                  };
                  
                  try {
                    const parsedResponse = JSON.parse(response);
                    if (parsedResponse.type === "menu" && parsedResponse.keyboard) {
                      editPayload.text = parsedResponse.text;
                      editPayload.reply_markup = {
                        inline_keyboard: parsedResponse.keyboard
                      };
                    }
                  } catch (e) {
                    editPayload.parse_mode = "Markdown";
                  }
                  
                  await fetch(apiUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(editPayload),
                  });
                }
                
                return c.text("OK", 200);
              }

              const message = payload.message?.text || "";
              const userId = String(payload.message?.from?.id || "");
              let chatId = payload.message?.chat?.id;
              const username = payload.message?.from?.username || "unknown";

              console.log(`📱 Message: "${message}", ChatID: ${chatId}, UserID: ${userId}`);
              logger?.info("📱 [Telegram] Parsed message", {
                message,
                userId,
                chatId,
                chatIdType: typeof chatId,
                username,
              });

              if (!chatId) {
                logger?.warn("⚠️ [Telegram] No chat ID found, skipping response");
                return c.text("OK", 200);
              }

              // Parse and execute command
              const response = await parseAndExecuteCommand(message, userId, mastra);
              console.log(`✅ Generated response (${response.length} chars)`);

              // Send response back to Telegram
              if (process.env.TELEGRAM_BOT_TOKEN) {
                const botToken = process.env.TELEGRAM_BOT_TOKEN;
                const apiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
                console.log(`🚀 Sending to Telegram API for chat ${chatId}...`);
                
                // Check if response is a menu JSON object
                let payload: any = {
                  chat_id: chatId,
                  text: response,
                  parse_mode: "Markdown",
                };
                
                try {
                  const parsedResponse = JSON.parse(response);
                  if (parsedResponse.type === "keyboard_menu" && parsedResponse.keyboard) {
                    payload.text = parsedResponse.text;
                    payload.reply_markup = {
                      keyboard: parsedResponse.keyboard,
                      resize_keyboard: true,
                      one_time_keyboard: false
                    };
                  } else if (parsedResponse.type === "menu" && parsedResponse.keyboard) {
                    payload.text = parsedResponse.text;
                    payload.reply_markup = {
                      inline_keyboard: parsedResponse.keyboard
                    };
                  }
                } catch (e) {
                  // Not JSON, treat as plain text response
                  payload.parse_mode = "Markdown";
                }

                logger?.info("📤 [Telegram] Sending request to Telegram API", {
                  url: apiUrl.substring(0, 50) + "...",
                  chatId,
                  responseLength: response.length,
                  hasKeyboard: payload.reply_markup ? true : false,
                });

                const apiResponse = await fetch(apiUrl, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify(payload),
                });

                const responseText = await apiResponse.text();
                console.log(`📡 Telegram API Status: ${apiResponse.status} - ${responseText.substring(0, 150)}`);
                
                let apiData: any = {};
                try {
                  apiData = JSON.parse(responseText);
                } catch (e) {
                  apiData = { text: responseText };
                }
                
                logger?.info("📡 [Telegram] API Response", {
                  status: apiResponse.status,
                  statusText: apiResponse.statusText,
                  ok: apiResponse.ok,
                  response: responseText.substring(0, 200),
                });

                if (apiResponse.ok) {
                  console.log("✅ Message sent to Telegram successfully!");
                  logger?.info("✅ [Telegram] Response sent successfully");
                } else {
                  console.log("❌ Failed to send to Telegram:", apiData.description || apiResponse.statusText);
                  logger?.error("❌ [Telegram] Failed to send response", {
                    error: apiData.description || apiResponse.statusText,
                    response: responseText,
                  });
                }
              } else {
                logger?.warn("⚠️ [Telegram] TELEGRAM_BOT_TOKEN not configured");
              }

              return c.text("OK", 200);
            } catch (error: any) {
              logger?.error("❌ [Telegram] Webhook error", {
                error: error.message,
                stack: error.stack,
              });
              return c.text("OK", 200); // Return OK even on error to prevent Telegram retries
            }
          };
        },
      },
    ],
  },
  logger:
    process.env.NODE_ENV === "production"
      ? new ProductionPinoLogger({
          name: "Mastra",
          level: "info",
        })
      : new PinoLogger({
          name: "Mastra",
          level: "info",
        }),
});

// Clear Telegram bot commands to remove autocomplete suggestions
async function clearTelegramCommands() {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  if (!botToken) return;
  
  try {
    const response = await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ commands: [] }),
    });
    
    if (response.ok) {
      console.log("✅ Telegram bot commands cleared");
    } else {
      console.log("⚠️ Failed to clear Telegram commands");
    }
  } catch (error: any) {
    console.log("⚠️ Error clearing Telegram commands:", error.message);
  }
}

// Clear commands on startup
clearTelegramCommands();

/*  Sanity check 1: Throw an error if there are more than 1 workflows.  */
// !!!!!! Do not remove this check. !!!!!!
if (Object.keys(mastra.getWorkflows()).length > 1) {
  throw new Error(
    "More than 1 workflows found. Currently, more than 1 workflows are not supported in the UI, since doing so will cause app state to be inconsistent.",
  );
}

/*  Sanity check 2: Throw an error if there are more than 1 agents.  */
// !!!!!! Do not remove this check. !!!!!!
if (Object.keys(mastra.getAgents()).length > 1) {
  throw new Error(
    "More than 1 agents found. Currently, more than 1 agents are not supported in the UI, since doing so will cause app state to be inconsistent.",
  );
}
