import { createStep, createWorkflow } from "../inngest";
import { z } from "zod";
import { mexcTradingAgent, parseAndExecuteCommand } from "../agents/mexcTradingAgent";

/**
 * Telegram Trading Workflow
 * 
 * This workflow processes incoming Telegram messages and executes trading commands
 * using the MEXC Trading Agent
 */

/**
 * Step 1: Process Trading Command
 * Receives Telegram message and processes it with the trading agent
 */
const processTradingCommand = createStep({
  id: "process-trading-command",
  description: "Processes incoming Telegram trading command using MEXC trading agent",

  inputSchema: z.object({
    threadId: z.string().describe("Unique thread ID for conversation memory"),
    userName: z.string().describe("Telegram username of the sender"),
    telegramUserId: z.string().describe("Telegram user ID of the sender"),
    message: z.string().describe("Trading command message from Telegram"),
    chatId: z.number().optional().describe("Telegram chat ID for sending response"),
  }),

  outputSchema: z.object({
    response: z.string().describe("Agent's response to the trading command"),
    success: z.boolean().describe("Whether the command was processed successfully"),
    chatId: z.number().optional().describe("Telegram chat ID to send response to"),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('📱 [processTradingCommand] Processing Telegram message', {
      userName: inputData.userName,
      message: inputData.message,
      chatId: inputData.chatId,
    });

    try {
      // Simple command parser - no LLM needed
      const response = parseAndExecuteCommand(inputData.message, inputData.telegramUserId);

      logger?.info('✅ [processTradingCommand] Command processed successfully', {
        responseLength: response.length,
      });

      return {
        response,
        success: true,
        chatId: inputData.chatId,
      };
    } catch (error: any) {
      logger?.error('❌ [processTradingCommand] Error processing command', {
        error: error.message,
      });

      return {
        response: `❌ Ошибка при обработке команды: ${error.message}`,
        success: false,
        chatId: inputData.chatId,
      };
    }
  },
});

/**
 * Step 2: Send Response to Telegram
 * Sends the agent's response back to the user via Telegram
 */
const sendTelegramResponse = createStep({
  id: "send-telegram-response",
  description: "Sends the trading agent's response back to Telegram user",

  inputSchema: z.object({
    response: z.string().describe("Response text to send"),
    success: z.boolean().describe("Whether the previous step was successful"),
    chatId: z.number().optional().describe("Telegram chat ID"),
  }),

  outputSchema: z.object({
    sent: z.boolean().describe("Whether the message was sent successfully"),
    message: z.string().describe("Status message"),
  }),

  execute: async ({ inputData, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('📤 [sendTelegramResponse] Sending response to Telegram', {
      responseLength: inputData.response.length,
      chatId: inputData.chatId,
    });

    try {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      
      if (!botToken) {
        throw new Error("TELEGRAM_BOT_TOKEN not configured");
      }

      if (!inputData.chatId) {
        logger?.warn('⚠️  [sendTelegramResponse] No chat ID provided, skipping send');
        return {
          sent: false,
          message: "No chat ID provided",
        };
      }

      const telegramApiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
      
      const response = await fetch(telegramApiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          chat_id: inputData.chatId,
          text: inputData.response,
          parse_mode: "HTML",
        }),
      });

      if (!response.ok) {
        throw new Error(`Telegram API error: ${response.statusText}`);
      }

      logger?.info('✅ [sendTelegramResponse] Response sent successfully');

      return {
        sent: true,
        message: "Response sent successfully to Telegram",
      };
    } catch (error: any) {
      logger?.error('❌ [sendTelegramResponse] Error sending response', {
        error: error.message,
      });

      return {
        sent: false,
        message: `Failed to send response: ${error.message}`,
      };
    }
  },
});

/**
 * Create the Telegram Trading Workflow
 * Chains the steps together to process commands and send responses
 */
export const telegramTradingWorkflow = createWorkflow({
  id: "telegram-trading-workflow",
  
  inputSchema: z.object({
    threadId: z.string().describe("Unique thread ID for conversation"),
    userName: z.string().describe("Telegram username"),
    telegramUserId: z.string().describe("Telegram user ID"),
    message: z.string().describe("Trading command message"),
    chatId: z.number().optional().describe("Telegram chat ID"),
  }) as any,

  outputSchema: z.object({
    sent: z.boolean(),
    message: z.string(),
  }),
})
  .then(processTradingCommand as any)
  .then(sendTelegramResponse as any)
  .commit();
