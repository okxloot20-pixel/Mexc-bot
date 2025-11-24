import { Mastra } from "@mastra/core";
import { MastraError } from "@mastra/core/error";
import { PinoLogger } from "@mastra/loggers";
import { LogLevel, MastraLogger } from "@mastra/core/logger";
import pino from "pino";
import { MCPServer } from "@mastra/mcp";
import { NonRetriableError } from "inngest";
import { z } from "zod";

import { sharedPostgresStorage } from "./storage";
import { db } from "./storage/db";
import { mexcAccounts } from "./storage/schema";
import { inngest, inngestServe } from "./inngest";
import { telegramTradingWorkflow } from "./workflows/telegramTradingWorkflow";
import { mexcTradingAgent, parseAndExecuteCommand } from "./agents/mexcTradingAgent";
import { registerTelegramTrigger } from "../triggers/telegramTriggers";
import { startSpreadMonitoring } from "./workflows/spreadMonitoringWorkflow";
import { eq, and } from "drizzle-orm";

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
          // 🔒 PRIVATE BOT - Only allowed users can access
          const ALLOWED_USERS = ["513426471"]; // Только твой ID
          
          return async (c: any) => {
            const mastra = c.get("mastra");
            const logger = mastra?.getLogger();
            
            try {
              const payload = await c.req.json();
              
              console.log("🔍 [TELEGRAM WEBHOOK RECEIVED]", JSON.stringify(payload, null, 2));
              logger?.info("🔍 [Telegram] Full payload received", JSON.stringify(payload, null, 2));
              logger?.info("🔍 [Telegram] Payload keys:", Object.keys(payload));
              logger?.info("🔍 [Telegram] Has message?", !!payload.message);
              logger?.info("🔍 [Telegram] Has callback_query?", !!payload.callback_query);
              
              // Log what type of event this is
              if (payload.message) {
                console.log("📨 EVENT TYPE: MESSAGE");
              } else if (payload.callback_query) {
                console.log("🔘 EVENT TYPE: CALLBACK_QUERY");
              } else {
                console.log("❓ EVENT TYPE: UNKNOWN", Object.keys(payload));
              }

              // Handle callback query (button clicks)
              if (payload.callback_query) {
                const callbackData = payload.callback_query.data;
                const callbackQueryId = payload.callback_query.id;
                const userId = String(payload.callback_query.from.id);
                // Get chatId from message or use userId as fallback (Telegram sends message with callback_query)
                const chatId = payload.callback_query.message?.chat?.id || payload.callback_query.from.id;
                const messageId = payload.callback_query.message?.message_id;
                
                // 🔒 Check if user is allowed
                if (!ALLOWED_USERS.includes(userId)) {
                  console.log(`🚫 UNAUTHORIZED ACCESS ATTEMPT: UserID ${userId} tried callback: ${callbackData}`);
                  logger?.warn("🚫 [Telegram] Unauthorized callback attempt", { userId, callbackData });
                  
                  // Send alert to user
                  if (process.env.TELEGRAM_BOT_TOKEN) {
                    const botToken = process.env.TELEGRAM_BOT_TOKEN;
                    const answerUrl = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
                    await fetch(answerUrl, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        callback_query_id: callbackQueryId,
                        text: "🚫 Доступ запрещен",
                        show_alert: true
                      }),
                    }).catch(err => console.log("⚠️ Error answering callback:", err));
                  }
                  return c.text("OK", 200);
                }
                
                console.log(`🔘 CALLBACK QUERY RECEIVED: "${callbackData}", UserID: ${userId}, CallbackID: ${callbackQueryId}`);
                logger?.info("🔘 [Telegram] Callback query RECEIVED", { callbackData, userId, chatId, callbackQueryId });
                
                // Acknowledge the callback query immediately
                if (process.env.TELEGRAM_BOT_TOKEN) {
                  const botToken = process.env.TELEGRAM_BOT_TOKEN;
                  const answerUrl = `https://api.telegram.org/bot${botToken}/answerCallbackQuery`;
                  console.log(`📨 Sending answerCallbackQuery for ${callbackQueryId}`);
                  await fetch(answerUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      callback_query_id: callbackQueryId,
                      text: "Обработка...",
                      show_alert: false
                    }),
                  }).catch(err => console.log("⚠️ Error answering callback:", err));
                }
                
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
                } else if (callbackData === "start") {
                  // Main menu
                  console.log(`🚀 START callback - calling parseAndExecuteCommand("/start")`);
                  response = await parseAndExecuteCommand("/start", userId, mastra);
                  console.log(`🚀 START callback response length: ${response.length} chars`);
                  console.log(`🚀 START callback response preview: ${response.substring(0, 150)}`);
                  logger?.info("🚀 [Telegram] START callback response", { length: response.length, preview: response.substring(0, 100) });
                } else if (callbackData === "positions") {
                  response = await parseAndExecuteCommand("/positions", userId, mastra);
                } else if (callbackData === "balance") {
                  response = await parseAndExecuteCommand("/balance", userId, mastra);
                } else if (callbackData === "fast") {
                  response = "⚡ *Fast команды*\n\n/fast add SYMBOL - добавить монету\n/fast list - список\n/fast remove SYMBOL - удалить";
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
                  console.log(`📦 Orders callback`);
                  response = await parseAndExecuteCommand("orders", userId, mastra);
                } else if (callbackData === "subscription") {
                  response = "🎯 *Подписка*\n\nФункция в разработке";
                } else if (callbackData === "signals") {
                  response = "🚨 *Сигналы*\n\nФункция в разработке";
                } else if (callbackData === "settings") {
                  response = "⚙️ *Настройки*\n\nФункция в разработке";
                } else if (callbackData === "help") {
                  response = "ℹ️ *Справка*\n\nОтправь: /help";
                } else if (callbackData === "back_to_main") {
                  response = await parseAndExecuteCommand("/start", userId, mastra);
                } else if (callbackData.startsWith("toggle_account_")) {
                  // Handle account toggle via callback
                  const accountId = parseInt(callbackData.split("_")[2]);
                  console.log(`🔘 Toggle account callback: accountId=${accountId}, userId=${userId}`);
                  logger?.info("🔘 [Telegram] Toggle account callback", { accountId, userId });
                  
                  try {
                    // Get current account status from DB
                    const account = await db.query.mexcAccounts.findFirst({
                      where: and(
                        eq(mexcAccounts.telegramUserId, userId),
                        eq(mexcAccounts.id, accountId)
                      ),
                    });
                    
                    if (account) {
                      // Toggle the account directly
                      const newStatus = !account.isActive;
                      await db.update(mexcAccounts)
                        .set({ isActive: newStatus })
                        .where(eq(mexcAccounts.id, account.id));
                      
                      console.log(`✅ Toggled account ${account.accountNumber}: ${newStatus ? "ON" : "OFF"}`);
                      
                      // Return the updated accounts list
                      response = await parseAndExecuteCommand("/accounts", userId, mastra);
                    } else {
                      response = `❌ Аккаунт #${accountId} не найден`;
                    }
                  } catch (error: any) {
                    console.log(`❌ Error in toggle callback: ${error.message}`);
                    response = `❌ Ошибка: ${error.message}`;
                  }
                } else if (callbackData === "my_accounts") {
                  // Show accounts list with delete buttons
                  console.log(`📋 My accounts callback`);
                  response = await parseAndExecuteCommand("/accounts", userId, mastra);
                } else if (callbackData === "delete_account_menu") {
                  // Show delete menu
                  console.log(`🗑️ Delete account menu`);
                  response = await parseAndExecuteCommand("delete_account_menu", userId, mastra);
                } else if (callbackData.startsWith("confirm_delete_")) {
                  // Handle confirm delete
                  console.log(`✅ Confirm delete: ${callbackData}`);
                  response = await parseAndExecuteCommand(callbackData, userId, mastra);
                } else if (callbackData.startsWith("delete_account_")) {
                  // Handle delete account via callback
                  console.log(`🗑️ Delete account callback: ${callbackData}`);
                  response = await parseAndExecuteCommand(callbackData, userId, mastra);
                } else if (callbackData === "accounts") {
                  // Show accounts again
                  console.log(`📋 Back to accounts`);
                  response = await parseAndExecuteCommand("/accounts", userId, mastra);
                } else if (callbackData === "fast" || callbackData === "show_fast" || callbackData === "add_coin" || callbackData === "delete_fast_menu" || callbackData === "show_account_menu" || callbackData === "show_fast_menu" ||
                           callbackData.startsWith("fast_cmd_") || callbackData.startsWith("delete_fast_cmd_") || callbackData.startsWith("delete_fast_confirm_") ||
                           callbackData === "show_auto" || callbackData === "show_auto_menu" || callbackData === "add_auto_coin" || callbackData === "delete_auto_menu" ||
                           callbackData.startsWith("auto_cmd_") || callbackData.startsWith("delete_auto_confirm_")) {
                  // Handle fast/auto command callbacks and menu navigation
                  console.log(`⚡ Fast/Auto callback: ${callbackData}`);
                  response = await parseAndExecuteCommand(callbackData, userId, mastra);
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
                    console.log(`📋 Parsed response type: ${parsedResponse.type}`);
                    console.log(`📋 Parsed response keyboard rows: ${parsedResponse.keyboard?.length || 0}`);
                    logger?.info("📋 [Telegram] Parsed response", { type: parsedResponse.type, hasKeyboard: !!parsedResponse.keyboard, keyboardRows: parsedResponse.keyboard?.length });
                    if ((parsedResponse.type === "menu" || parsedResponse.type === "keyboard_menu") && parsedResponse.keyboard) {
                      editPayload.text = parsedResponse.text;
                      if (parsedResponse.type === "menu") {
                        editPayload.reply_markup = {
                          inline_keyboard: parsedResponse.keyboard
                        };
                      } else if (parsedResponse.type === "keyboard_menu") {
                        editPayload.reply_markup = {
                          keyboard: parsedResponse.keyboard,
                          resize_keyboard: true,
                          one_time_keyboard: false
                        };
                      }
                      delete editPayload.parse_mode;
                      console.log(`🎯 Setting keyboard with ${parsedResponse.keyboard.length} rows`);
                      console.log(`🎯 First row buttons: ${JSON.stringify(parsedResponse.keyboard[0], null, 2)}`);
                      logger?.info("🎯 [Telegram] Setting keyboard", { type: parsedResponse.type, rows: parsedResponse.keyboard.length });
                    }
                  } catch (e) {
                    editPayload.parse_mode = "Markdown";
                    console.log(`📝 Response is plain text (not JSON)`, e);
                  }
                  
                  console.log(`📤 Sending editMessageText to Telegram`);
                  console.log(`📤 Full payload:`, JSON.stringify(editPayload, null, 2).substring(0, 300));
                  logger?.info("📤 [Telegram] Sending editMessageText", { chatId, messageId, hasReplyMarkup: !!editPayload.reply_markup });
                  
                  try {
                    const editResponse = await fetch(apiUrl, {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify(editPayload),
                    });
                    const editResult = await editResponse.json();
                    
                    if (!editResult.ok) {
                      console.log(`⚠️ editMessageText failed: ${editResult.description}`);
                      console.log(`📋 Error response: ${JSON.stringify(editResult)}`);
                      logger?.warn("⚠️ [Telegram] editMessageText failed", { error: editResult.description });
                      
                      // Fallback to sendMessage
                      console.log(`🔄 Falling back to sendMessage...`);
                      const sendPayload: any = {
                        chat_id: chatId,
                        text: editPayload.text
                      };
                      
                      // Only add parse_mode if no keyboard
                      if (!editPayload.reply_markup) {
                        sendPayload.parse_mode = editPayload.parse_mode || "Markdown";
                      }
                      
                      if (editPayload.reply_markup) {
                        sendPayload.reply_markup = editPayload.reply_markup;
                        console.log(`📱 Including reply_markup: ${JSON.stringify(editPayload.reply_markup).substring(0, 100)}`);
                      }
                      
                      console.log(`📨 sendMessage payload:`, JSON.stringify(sendPayload).substring(0, 200));
                      const sendApiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
                      const sendResponse = await fetch(sendApiUrl, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(sendPayload),
                      });
                      const sendResult = await sendResponse.json();
                      if (sendResult.ok) {
                        console.log(`✅ Sent via sendMessage fallback (message_id: ${sendResult.result.message_id})`);
                        logger?.info("✅ [Telegram] Sent via sendMessage fallback");
                      } else {
                        console.log(`❌ sendMessage also failed: ${sendResult.description}`);
                        logger?.error("❌ [Telegram] sendMessage fallback failed", { error: sendResult.description });
                      }
                    } else {
                      console.log(`✅ editMessageText sent successfully`);
                    }
                  } catch (error: any) {
                    console.log(`❌ Error sending editMessageText: ${error.message}`);
                    logger?.error("❌ [Telegram] Error sending editMessageText", { error: error.message });
                  }
                }
                
                return c.text("OK", 200);
              }

              const message = payload.message?.text || "";
              const userId = String(payload.message?.from?.id || "");
              let chatId = payload.message?.chat?.id;
              const username = payload.message?.from?.username || "unknown";

              // 🔒 Check if user is allowed
              if (!ALLOWED_USERS.includes(userId)) {
                console.log(`🚫 UNAUTHORIZED ACCESS ATTEMPT: UserID ${userId} sent message: "${message}"`);
                logger?.warn("🚫 [Telegram] Unauthorized message attempt", { userId, message });
                
                // Send error response
                if (process.env.TELEGRAM_BOT_TOKEN && chatId) {
                  const botToken = process.env.TELEGRAM_BOT_TOKEN;
                  const apiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
                  await fetch(apiUrl, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      chat_id: chatId,
                      text: "🚫 Доступ запрещен. Этот бот только для авторизованных пользователей."
                    }),
                  }).catch(err => console.log("⚠️ Error sending access denied:", err));
                }
                return c.text("OK", 200);
              }

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
                };
                
                try {
                  const parsedResponse = JSON.parse(response);
                  console.log(`📋 Parsed response type:`, parsedResponse.type);
                  console.log(`📋 Has keyboard:`, !!parsedResponse.keyboard);
                  
                  if (parsedResponse.type === "keyboard_menu" && parsedResponse.keyboard) {
                    payload.text = parsedResponse.text;
                    payload.reply_markup = {
                      keyboard: parsedResponse.keyboard,
                      resize_keyboard: true,
                      one_time_keyboard: false
                    };
                    payload.parse_mode = "Markdown";
                    console.log(`✅ Using reply_keyboard with ${parsedResponse.keyboard.length} rows`);
                  } else if (parsedResponse.type === "menu" && parsedResponse.keyboard) {
                    payload.text = parsedResponse.text;
                    // Ensure inline_keyboard is properly structured
                    payload.reply_markup = {
                      inline_keyboard: parsedResponse.keyboard
                    };
                    // CRITICAL: Don't use parse_mode with inline_keyboard - it breaks button recognition!
                    console.log(`✅ Using inline_keyboard with ${parsedResponse.keyboard.length} rows`);
                    console.log(`✅ reply_markup structure:`, JSON.stringify(payload.reply_markup, null, 2).substring(0, 200));
                  }
                } catch (e) {
                  // Not JSON, treat as plain text response (no parse_mode - Markdown breaks with emojis and Cyrillic)
                  console.log(`📝 Response is plain text, not JSON`);
                }
                
                // Remove parse_mode if inline_keyboard is present
                if (payload.reply_markup?.inline_keyboard) {
                  delete payload.parse_mode;
                  console.log(`🛡️ Removed parse_mode for inline_keyboard compatibility`);
                }
                
                console.log(`📤 Final payload keys:`, Object.keys(payload));
                console.log(`📤 Final payload for Telegram:`, JSON.stringify(payload, null, 2).substring(0, 400));

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

// Start spread monitoring background job
setTimeout(() => {
  startSpreadMonitoring(mastra).catch((error: any) => {
    mastra.getLogger()?.error("❌ Failed to start spread monitoring:", error);
  });
}, 2000);

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

// Graceful shutdown handler for Reserved VM stability
// Handles SIGTERM and SIGINT signals to prevent unexpected crashes
process.on("SIGTERM", async () => {
  const logger = mastra.getLogger();
  logger?.info("🛑 [System] Received SIGTERM signal, gracefully shutting down...");
  process.exit(0);
});

process.on("SIGINT", async () => {
  const logger = mastra.getLogger();
  logger?.info("🛑 [System] Received SIGINT signal, gracefully shutting down...");
  process.exit(0);
});

// Catch uncaught exceptions to prevent silent crashes
process.on("uncaughtException", (error: Error) => {
  const logger = mastra.getLogger();
  logger?.error("💥 [System] Uncaught exception detected", {
    message: error.message,
    stack: error.stack,
  });
  process.exit(1);
});

// Catch unhandled promise rejections
process.on("unhandledRejection", (reason: any, promise: Promise<any>) => {
  const logger = mastra.getLogger();
  logger?.error("💥 [System] Unhandled promise rejection", {
    reason: String(reason),
    promise: String(promise),
  });
});
