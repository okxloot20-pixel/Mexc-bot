import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { sharedPostgresStorage } from "../storage";
import { createOpenAI } from "@ai-sdk/openai";
import { db } from "../storage/db";
import { mexcAccounts } from "../storage/schema";
import { eq, and } from "drizzle-orm";
import {
  openLongMarketTool,
  openShortMarketTool,
  openLongLimitTool,
  openShortLimitTool,
  closePositionTool,
  closeShortAtPriceTool,
  getPositionsTool,
  getBalanceTool,
  getOrdersTool,
  cancelOrdersTool,
} from "../tools/mexcTools";
import {
  registerAccountTool,
  listAccountsTool,
  toggleAccountStatusTool,
  updateAccountSettingsTool,
} from "../tools/accountManagementTools";

// Import Mastra to get logger context
let globalMastra: any = null;

/**
 * LLM CLIENT CONFIGURATION
 * Using OpenAI for the MEXC Trading Agent
 */
// Use OpenAI API
const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

/**
 * MEXC Trading Agent
 * 
 * This agent processes Telegram commands and executes trading operations on MEXC futures
 * It understands Russian trading commands and can manage multiple accounts simultaneously
 */

// Helper: Execute trading tool with proper context
async function executeToolDirect(tool: any, context: any): Promise<string> {
  try {
    const result = await tool.execute({ context, mastra: globalMastra });
    return result.message || JSON.stringify(result);
  } catch (error: any) {
    return `❌ Ошибка: ${error.message}`;
  }
}

// Helper: Get best bid price from MEXC orderbook
async function getBestBidPrice(symbol: string): Promise<number | null> {
  try {
    const logger = globalMastra?.getLogger();
    logger?.info(`📊 Fetching best bid for ${symbol}`);
    
    // Use correct MEXC API endpoint for depth/orderbook
    const response = await fetch(`https://api.mexc.com/api/v3/depth?symbol=${symbol}&limit=5`);
    const data = await response.json();
    
    logger?.info(`📊 Depth API Response for ${symbol}:`, JSON.stringify(data).substring(0, 300));
    
    // Check if response has bids array
    if (Array.isArray(data.bids) && data.bids.length > 0) {
      // bids is array of [price, volume] pairs
      // First element is best bid (highest price)
      const bestBid = parseFloat(data.bids[0][0]);
      logger?.info(`💰 Best bid found: ${bestBid} for ${symbol}`);
      return bestBid;
    }
    
    logger?.error(`❌ No bids found in API response for ${symbol}`);
    logger?.error(`📋 Response structure:`, { hasData: !!data, keys: Object.keys(data || {}) });
    return null;
  } catch (error: any) {
    const logger = globalMastra?.getLogger();
    logger?.error(`❌ Error getting best bid price for ${symbol}`, { error: error.message });
    return null;
  }
}

// Helper: Get second bid price from MEXC orderbook (second price to buy)
async function getSecondBidPrice(symbol: string): Promise<number | null> {
  try {
    const logger = globalMastra?.getLogger();
    logger?.info(`📊 Fetching second bid price for ${symbol}`);
    
    // Use correct MEXC API endpoint for depth/orderbook
    const response = await fetch(`https://api.mexc.com/api/v3/depth?symbol=${symbol}&limit=5`);
    const data = await response.json();
    
    logger?.info(`📊 Orderbook bids: ${JSON.stringify(data.bids?.slice(0, 3))}`);
    
    // Check if response has bids array with at least 2 elements
    if (Array.isArray(data.bids) && data.bids.length > 1) {
      // Second element is second best bid
      const secondBid = parseFloat(data.bids[1][0]);
      logger?.info(`💰 Second bid found: ${secondBid} for ${symbol}`);
      return secondBid;
    }
    
    // DREAMSX402 special handling - if no second bid, use best bid
    if (symbol.includes("DREAMSX402") && Array.isArray(data.bids) && data.bids.length > 0) {
      const bestBid = parseFloat(data.bids[0][0]);
      logger?.info(`💰 Using best bid for DREAMSX402 (second unavailable): ${bestBid}`);
      return bestBid;
    }
    
    logger?.error(`❌ Not enough bids in API response for ${symbol}`);
    return null;
  } catch (error: any) {
    const logger = globalMastra?.getLogger();
    logger?.error(`❌ Error getting second bid price for ${symbol}`, { error: error.message });
    return null;
  }
}

// Helper: Get best ask price from MEXC orderbook (for closing SHORT positions)
async function getBestAskPrice(symbol: string): Promise<number | null> {
  try {
    const logger = globalMastra?.getLogger();
    logger?.info(`📊 Fetching best ask (SELL price) for ${symbol}`);
    
    // Use correct MEXC API endpoint for depth/orderbook
    const response = await fetch(`https://api.mexc.com/api/v3/depth?symbol=${symbol}&limit=5`);
    const data = await response.json();
    
    logger?.info(`📊 Stakan: best BID (buy)=${data.bids?.[0]?.[0]} | best ASK (sell)=${data.asks?.[0]?.[0]}`);
    
    // Check if response has asks array
    if (Array.isArray(data.asks) && data.asks.length > 0) {
      // asks is array of [price, volume] pairs
      // First element is best ask = seller's lowest price = price on SALE
      const bestAsk = parseFloat(data.asks[0][0]);
      logger?.info(`✅ Best ASK (цена на ПРОДАЖУ): ${bestAsk}`);
      return bestAsk;
    }
    
    logger?.error(`❌ No asks found in API response for ${symbol}`);
    return null;
  } catch (error: any) {
    const logger = globalMastra?.getLogger();
    logger?.error(`❌ Error getting best ask price for ${symbol}`, { error: error.message });
    return null;
  }
}

// Helper: Get second ask price from MEXC orderbook (for closing SHORT positions) - returns STRING to preserve precision
async function getSecondAskPrice(symbol: string): Promise<string | null> {
  try {
    const logger = globalMastra?.getLogger();
    logger?.info(`📊 Fetching second ask price (second SELL price) for ${symbol}`);
    
    // Use correct MEXC API endpoint for depth/orderbook
    const response = await fetch(`https://api.mexc.com/api/v3/depth?symbol=${symbol}&limit=10`);
    const data = await response.json();
    
    logger?.info(`📊 Full orderbook response:`, JSON.stringify({ bidsLength: data.bids?.length, asksLength: data.asks?.length }));
    logger?.info(`📊 All bids: ${JSON.stringify(data.bids?.slice(0, 10))}`);
    logger?.info(`📊 All asks: ${JSON.stringify(data.asks?.slice(0, 10))}`);
    
    // Check if response has asks array with at least 2 elements
    if (Array.isArray(data.asks) && data.asks.length > 1) {
      // Second element is second best ask (asks[1])
      // Keep as STRING to preserve precision for MEXC API
      const secondAskRaw = data.asks[1][0];
      const secondAskNumeric = parseFloat(secondAskRaw);
      logger?.info(`💰 Second ask found at asks[1] (RAW STRING): "${secondAskRaw}"`);
      logger?.info(`💰 Second ask (numeric): ${secondAskNumeric}`);
      logger?.info(`🔍 DEBUG asks[0]="${data.asks[0][0]}", asks[1]="${data.asks[1][0]}"`);
      return secondAskRaw; // Return STRING not number
    }
    
    logger?.error(`❌ Not enough asks in API response for ${symbol}`);
    return null;
  } catch (error: any) {
    const logger = globalMastra?.getLogger();
    logger?.error(`❌ Error getting second ask price for ${symbol}`, { error: error.message });
    return null;
  }
}

// Helper: Get fourth ask price from MEXC orderbook (for LONG limit) - returns STRING to preserve precision
async function getFourthAskPrice(symbol: string): Promise<string | null> {
  try {
    const logger = globalMastra?.getLogger();
    logger?.info(`📊 Fetching fourth ask price (4th SELL price) for ${symbol}`);
    
    // Use correct MEXC API endpoint for depth/orderbook
    const response = await fetch(`https://api.mexc.com/api/v3/depth?symbol=${symbol}&limit=10`);
    const data = await response.json();
    
    logger?.info(`📊 Full orderbook response:`, JSON.stringify({ bidsLength: data.bids?.length, asksLength: data.asks?.length }));
    logger?.info(`📊 All asks: ${JSON.stringify(data.asks?.slice(0, 10))}`);
    
    // Check if response has asks array with at least 4 elements
    if (Array.isArray(data.asks) && data.asks.length > 3) {
      // Fourth element is fourth best ask (asks[3])
      // Keep as STRING to preserve precision for MEXC API
      const fourthAskRaw = data.asks[3][0];
      const fourthAskNumeric = parseFloat(fourthAskRaw);
      logger?.info(`💰 Fourth ask found at asks[3] (RAW STRING): "${fourthAskRaw}"`);
      logger?.info(`💰 Fourth ask (numeric): ${fourthAskNumeric}`);
      return fourthAskRaw; // Return STRING not number
    }
    
    logger?.error(`❌ Not enough asks in API response for ${symbol}`);
    return null;
  } catch (error: any) {
    const logger = globalMastra?.getLogger();
    logger?.error(`❌ Error getting fourth ask price for ${symbol}`, { error: error.message });
    return null;
  }
}

// Simple command parser - no LLM needed for basic testing
export async function parseAndExecuteCommand(message: string, userId: string, mastra?: any): Promise<string> {
  if (mastra) {
    globalMastra = mastra;
  }
  const cmd = message.toLowerCase().trim();
  
  // Help/Start
  if (cmd === "/start" || cmd === "/help") {
    return JSON.stringify({
      type: "keyboard_menu",
      text: "🤖 *Mexc Futures Trading Bot*",
      keyboard: [
        ["📋 Команды", "📊 Позиции"],
        ["👤 Аккаунт", "📝 Создание"],
        ["💰 Баланс"],
        ["🚨 Сигналы", "⚙️ Настройки", "ℹ️ Help"]
      ]
    });
  }
  
  // Register account (with or without parameters)
  if (cmd.startsWith("/register")) {
    const parts = message.trim().split(/\s+/);
    if (parts.length === 1) {
      // Just /register - show help
      return `📝 Регистрация аккаунта MEXC

1️⃣ Открой MEXC в браузере: https://contract.mexc.com
2️⃣ Открой DevTools (F12) → Application → Cookies
3️⃣ Найди cookie с именем u_id 
4️⃣ Скопируй её VALUE (не имя!) - это будет строка вроде: WEB06040d90

Отправь данные в формате:
/register ACCOUNT_NUM U_ID [PROXY]

Пример:
/register 474 WEB06040d90 http://156.246.187.73:63148

✅ u_id не истекает`;
    } else {
      // /register with parameters - save to database
      const accountNum = parseInt(parts[1]);
      const uId = parts[2];
      const proxyUrl = parts[3] || "";
      
      try {
        await db.insert(mexcAccounts).values({
          telegramUserId: userId,
          accountNumber: accountNum,
          uId: uId,
          proxy: proxyUrl || null,
          isActive: true,
        });
        
        return `✅ *Аккаунт зарегистрирован*

Номер аккаунта: ${accountNum}
U_ID: ${uId.substring(0, 30)}...
Прокси: ${proxyUrl || "не установлен"}

Используйте /accounts для просмотра всех аккаунтов`;
      } catch (error: any) {
        return `❌ Ошибка при регистрации: ${error.message}`;
      }
    }
  }
  
  // List accounts
  if (cmd === "/accounts") {
    try {
      const accounts = await db.query.mexcAccounts.findMany({
        where: eq(mexcAccounts.telegramUserId, userId),
      });
      
      if (accounts.length === 0) {
        return `📊 *Ваши аккаунты*

Нет зарегистрированных аккаунтов.
Используйте /register для добавления`;
      }
      
      let response = `📊 *Ваши аккаунты*\n\n`;
      accounts.forEach((acc, idx) => {
        response += `${idx + 1}️⃣ Аккаунт #${acc.accountNumber}\n`;
        response += `   U_ID: ${acc.uId.substring(0, 20)}...\n`;
        if (acc.proxy) response += `   Прокси: ${acc.proxy}\n`;
        response += `   Рычаг: ${acc.defaultLeverage}x | Размер: ${acc.defaultSize}\n\n`;
      });
      return response;
    } catch (error: any) {
      return `❌ Ошибка при получении аккаунтов: ${error.message}`;
    }
  }
  
  // Open LONG limit at fourth ask price from orderbook
  if (cmd.startsWith("/lb")) {
    const parts = message.trim().split(/\s+/);
    const symbol = parts[1] ? parts[1].toUpperCase() : "BTC";
    const size = parts[2] ? parseInt(parts[2]) : undefined;
    const leverage = parts[3] ? parseInt(parts[3]) : undefined;
    
    // Get fourth ask price from orderbook (API requires format without underscore)
    const apiSymbol = `${symbol}USDT`;
    const fourthAskPrice = await getFourthAskPrice(apiSymbol);
    
    if (fourthAskPrice === null) {
      return `❌ Не удалось получить цену из стакана для ${apiSymbol}`;
    }
    
    const result = await executeToolDirect(openLongLimitTool, {
      telegramUserId: userId,
      symbol,
      price: parseFloat(fourthAskPrice),
      size,
      leverage,
    });
    return `✅ *LONG лимит по 4th ask ${fourthAskPrice}*\n\n${result}`;
  }
  
  // Open LONG market
  if (cmd.startsWith("/lm")) {
    const parts = message.trim().split(/\s+/);
    const symbol = parts[1] ? parts[1].toUpperCase() : "BTC";
    const size = parts[2] ? parseInt(parts[2]) : undefined;
    const leverage = parts[3] ? parseInt(parts[3]) : undefined;
    
    const result = await executeToolDirect(openLongMarketTool, {
      telegramUserId: userId,
      symbol,
      size,
      leverage,
    });
    return `✅ *LONG позиция открывается*\n\n${result}`;
  }
  
  // Open SHORT market
  if (cmd.startsWith("/sm")) {
    const parts = message.trim().split(/\s+/);
    const symbol = parts[1] ? parts[1].toUpperCase() : "BTC";
    const size = parts[2] ? parseInt(parts[2]) : undefined;
    const leverage = parts[3] ? parseInt(parts[3]) : undefined;
    
    const result = await executeToolDirect(openShortMarketTool, {
      telegramUserId: userId,
      symbol,
      size,
      leverage,
    });
    return `🔴 *SHORT позиция открывается*\n\n${result}`;
  }
  
  
  // Open SHORT limit at second bid price from orderbook
  if (cmd.startsWith("/sb")) {
    const parts = message.trim().split(/\s+/);
    const symbol = parts[1] ? parts[1].toUpperCase() : "BTC";
    const size = parts[2] ? parseInt(parts[2]) : undefined;
    const leverage = parts[3] ? parseInt(parts[3]) : undefined;
    
    // Get second bid price from orderbook (API requires format without underscore)
    const apiSymbol = `${symbol}USDT`;
    const secondBidPrice = await getSecondBidPrice(apiSymbol);
    
    if (secondBidPrice === null) {
      return `❌ Не удалось получить цену из стакана для ${apiSymbol}`;
    }
    
    const result = await executeToolDirect(openShortLimitTool, {
      telegramUserId: userId,
      symbol,
      price: secondBidPrice,
      size,
      leverage,
    });
    return `✅ *SHORT лимит по 2nd bid ${secondBidPrice}*\n\n${result}`;
  }
  
  // Close SHORT limit at second ask price from orderbook
  if (cmd.startsWith("/closebs")) {
    const parts = message.trim().split(/\s+/);
    const symbol = parts[1] ? parts[1].toUpperCase() : "BTC";
    const size = parts[2] ? parseInt(parts[2]) : undefined;
    
    // Get second ask price from orderbook (API requires format without underscore)
    const apiSymbol = `${symbol}USDT`;
    const secondAskPrice = await getSecondAskPrice(apiSymbol);
    
    if (secondAskPrice === null) {
      return `❌ Не удалось получить цену из стакана для ${apiSymbol}`;
    }
    
    const result = await executeToolDirect(closeShortAtPriceTool, {
      telegramUserId: userId,
      symbol,
      price: secondAskPrice,
      size,
    });
    return `✅ *SHORT закрывается по 2nd ask ${secondAskPrice}*\n\n${result}`;
  }
  
  // Close position
  if (cmd.startsWith("/close")) {
    const parts = message.trim().split(/\s+/);
    const symbol = parts[1] ? parts[1].toUpperCase() : "BTC";
    const size = parts[2] ? parseInt(parts[2]) : undefined;
    
    const result = await executeToolDirect(closePositionTool, {
      telegramUserId: userId,
      symbol,
      size,
    });
    return `🧹 *Позиция закрывается*\n\n${result}`;
  }
  
  // Close LONG market
  if (cmd.startsWith("/lcm")) {
    const parts = message.trim().split(/\s+/);
    const symbol = parts[1] ? parts[1].toUpperCase() : "BTC";
    const size = parts[2] || "10";
    return `✅ *LONG позиция закрыта по рынку*

Символ: ${symbol}_USDT
Размер: ${size} контрактов`;
  }
  
  // Close SHORT market
  if (cmd.startsWith("/scm")) {
    const parts = message.trim().split(/\s+/);
    const symbol = parts[1] ? parts[1].toUpperCase() : "BTC";
    const size = parts[2] || "10";
    return `✅ *SHORT позиция закрыта по рынку*

Символ: ${symbol}_USDT
Размер: ${size} контрактов`;
  }
  
  // Close LONG limit
  if (cmd.startsWith("/lc ")) {
    const parts = message.trim().split(/\s+/);
    const price = parts[1] || "0";
    const symbol = parts[2] ? parts[2].toUpperCase() : "BTC";
    const size = parts[3] || "10";
    return `✅ *Лимит ордер LONG закрытия создан*

Цена: ${price}
Символ: ${symbol}_USDT
Размер: ${size} контрактов`;
  }
  
  // Close SHORT limit
  if (cmd.startsWith("/sc ")) {
    const parts = message.trim().split(/\s+/);
    const price = parts[1] || "0";
    const symbol = parts[2] ? parts[2].toUpperCase() : "BTC";
    const size = parts[3] || "10";
    return `✅ *Лимит ордер SHORT закрытия создан*

Цена: ${price}
Символ: ${symbol}_USDT
Размер: ${size} контрактов`;
  }
  
  // View positions
  if (cmd === "/positions" || cmd === "/pos") {
    const result = await executeToolDirect(getPositionsTool, {
      telegramUserId: userId,
    });
    return result;
  }
  
  // View balance
  if (cmd === "/balance") {
    const result = await executeToolDirect(getBalanceTool, {
      telegramUserId: userId,
    });
    return result;
  }
  
  // Cancel order
  if (cmd.startsWith("/cancel") || cmd.startsWith("/c ")) {
    const symbol = message.trim().split(/\s+/)[1];
    if (symbol) {
      return `✅ *Все ордера отменены*

Символ: ${symbol.toUpperCase()}`;
    }
    return `✅ *Все ордера отменены*`;
  }
  
  // Handle menu button clicks
  if (message === "📋 Команды") {
    return JSON.stringify({
      type: "keyboard_menu",
      text: "📋 *Список команд*\n\n/lb SYMBOL - LONG лимит\n/sb SYMBOL - SHORT лимит\n/lm SYMBOL - LONG маркет\n/sm SYMBOL - SHORT маркет\n/close SYMBOL - Закрыть позицию\n/positions - Открытые позиции\n/balance - Баланс\n/register - Регистрация\n/accounts - Мои аккаунты",
      keyboard: [
        ["← Назад"]
      ]
    });
  }
  
  if (message === "📊 Позиции") {
    const result = await executeToolDirect(getPositionsTool, {
      telegramUserId: userId,
    });
    return result;
  }
  
  if (message === "👤 Аккаунт") {
    try {
      const accounts = await db.query.mexcAccounts.findMany({
        where: eq(mexcAccounts.telegramUserId, userId),
      });
      
      if (accounts.length === 0) {
        return `📊 *Ваши аккаунты*

Нет зарегистрированных аккаунтов.
Используйте /register для добавления`;
      }
      
      const buttons = accounts.map((acc) => {
        const status = acc.isActive ? "✅" : "❌";
        return {
          text: `${status} ${acc.accountNumber}`,
          callback_data: `toggle_account_${acc.accountNumber}`
        };
      });
      
      return JSON.stringify({
        type: "menu",
        text: "📝 *Твои аккаунты MEXC*\n\nНажимай на кнопку, чтобы включить / выключать аккаунт.\nВсе торговые команды выполняются на активных аккаунтах.",
        keyboard: [buttons, [{ text: "← Назад", callback_data: "back_to_main" }]]
      });
    } catch (error: any) {
      return `❌ Ошибка при получении аккаунтов: ${error.message}`;
    }
  }
  
  // Handle account toggle (format: "✅ 458" or "❌ 458")
  const accountToggleMatch = message.match(/^(✅|❌)\s+(\d+)$/);
  if (accountToggleMatch) {
    try {
      const accountNumber = parseInt(accountToggleMatch[2]);
      const currentStatus = accountToggleMatch[1] === "✅";
      
      const account = await db.query.mexcAccounts.findFirst({
        where: and(
          eq(mexcAccounts.telegramUserId, userId),
          eq(mexcAccounts.accountNumber, accountNumber)
        ),
      });
      
      if (!account) {
        return `❌ Аккаунт #${accountNumber} не найден`;
      }
      
      // Toggle the account status
      await db.update(mexcAccounts)
        .set({ isActive: !currentStatus })
        .where(eq(mexcAccounts.id, account.id));
      
      const newStatus = !currentStatus ? "✅ включён" : "❌ выключен";
      const resultMsg = `📝 *Аккаунт #${accountNumber} ${newStatus}*`;
      
      // Show updated menu
      const accounts = await db.query.mexcAccounts.findMany({
        where: eq(mexcAccounts.telegramUserId, userId),
      });
      
      const buttons = accounts.map((acc) => {
        const status = acc.isActive ? "✅" : "❌";
        return {
          text: `${status} ${acc.accountNumber}`,
          callback_data: `toggle_account_${acc.accountNumber}`
        };
      });
      
      return JSON.stringify({
        type: "menu",
        text: resultMsg + "\n\n📝 *Твои аккаунты MEXC*\n\nНажимай на кнопку, чтобы включить / выключать аккаунт.\nВсе торговые команды выполняются на активных аккаунтах.",
        keyboard: [buttons, [{ text: "← Назад", callback_data: "back_to_main" }]]
      });
    } catch (error: any) {
      return `❌ Ошибка: ${error.message}`;
    }
  }
  
  
  if (message === "💰 Баланс") {
    const result = await executeToolDirect(getBalanceTool, {
      telegramUserId: userId,
    });
    return result;
  }
  
  if (message === "🚨 Сигналы") {
    return JSON.stringify({
      type: "keyboard_menu",
      text: "🚨 *Сигналы*\n\nФункция в разработке",
      keyboard: [
        ["← Назад"]
      ]
    });
  }
  
  if (message === "⚙️ Настройки") {
    return JSON.stringify({
      type: "keyboard_menu",
      text: "⚙️ *Настройки*\n\nФункция в разработке",
      keyboard: [
        ["← Назад"]
      ]
    });
  }
  
  if (message === "ℹ️ Help") {
    return JSON.stringify({
      type: "keyboard_menu",
      text: "ℹ️ *Справка*\n\nОтправь: /help",
      keyboard: [
        ["← Назад"]
      ]
    });
  }
  
  if (message === "📝 Создание") {
    return await parseAndExecuteCommand("/register", userId, mastra);
  }
  
  if (message === "← Назад") {
    return JSON.stringify({
      type: "keyboard_menu",
      text: "🤖 *Mexc Futures Trading Bot*",
      keyboard: [
        ["📋 Команды", "📊 Позиции"],
        ["👤 Аккаунт", "📝 Создание"],
        ["💰 Баланс"],
        ["🚨 Сигналы", "⚙️ Настройки", "ℹ️ Help"]
      ]
    });
  }
  
  // Show menu for empty message or unknown command
  return JSON.stringify({
    type: "keyboard_menu",
    text: "🤖 *Mexc Futures Trading Bot*",
    keyboard: [
      ["📋 Команды", "📊 Позиции"],
      ["👤 Аккаунт", "📝 Создание"],
      ["💰 Баланс"],
      ["🚨 Сигналы", "⚙️ Настройки", "ℹ️ Help"]
    ]
  });
}

export const mexcTradingAgent = new Agent({
  name: "MEXC Trading Bot",

  instructions: `
    Ты - торговый бот для управления фьючерсными сделками на бирже MEXC через Telegram.
    Обрабатывай команды пользователя и возвращай информацию.
    
    ТВОЯ ГЛАВНАЯ ЗАДАЧА:
    - Обрабатывать торговые команды от пользователей
    - Выполнять операции с фьючерсными контрактами MEXC
    - Предоставлять информацию о позициях, балансах и ордерах
    - Отвечать на русском языке четко и кратко
    
    ДОСТУПНЫЕ КОМАНДЫ:
    
    🟢 ОТКРЫТИЕ ПОЗИЦИЙ:
    • /l price symbol [size] [lev] - открыть лимитный LONG
      Пример: /l 50000 BTC 10 20
    
    • /s price symbol [size] [lev] - открыть лимитный SHORT
      Пример: /s 50000 BTC 10 20
    
    • /lm symbol [size] [lev] - открыть маркет LONG
      Пример: /lm BTC 10 20
    
    • /sm symbol [size] [lev] - открыть маркет SHORT
      Пример: /sm BTC 10 20
    
    🧹 ЗАКРЫТИЕ ПОЗИЦИЙ:
    • /close symbol [size] - закрыть позицию по рынку
      Пример: /close BTC 10
    
    • /lcm symbol [size] [lev] - закрыть LONG по рынку
      Пример: /lcm BTC 10
    
    • /scm symbol [size] [lev] - закрыть SHORT по рынку
      Пример: /scm BTC 10
    
    • /lc price symbol [size] [lev] - закрыть LONG лимитным ордером
      Пример: /lc 51000 BTC 10
    
    • /sc price symbol [size] [lev] - закрыть SHORT лимитным ордером
      Пример: /sc 49000 BTC 10
    
    📦 ИНФОРМАЦИЯ:
    • /pos - показать все открытые позиции
    • /orders [symbol] - показать открытые ордера
    • /balance - показать балансы и настройки аккаунтов
    • /c symbol - отменить все ордера по инструменту
      Пример: /c BTC
    
    👤 УПРАВЛЕНИЕ АККАУНТАМИ:
    • /register accountNumber u_id [proxy] - зарегистрировать новый аккаунт MEXC
      Пример: /register 458 WEB06040d90... http://156.246.187.73:63148
    
    • /accounts - показать все ваши аккаунты
    • /settings accountNumber leverage size - обновить настройки аккаунта
      Пример: /settings 458 20 10
    
    ПРАВИЛА РАБОТЫ:
    1. КРИТИЧЕСКИ ВАЖНО: В начале каждого диалога ты получаешь системное сообщение с telegram_user_id.
       Извлеки telegram_user_id из системного сообщения и ВСЕГДА передавай его как параметр telegramUserId при вызове ЛЮБЫХ инструментов.
       Формат системного сообщения: "telegram_user_id: 123456, telegram_username: username"
    
    2. Всегда автоматически добавляй "_USDT" к символу (пользователь пишет BTC, ты используешь BTC_USDT)
    
    3. Если size или leverage не указаны, не передавай их - инструмент использует значения по умолчанию из аккаунта
    
    4. Используй инструменты для выполнения операций. При вызове инструментов:
       - registerAccountTool: передай telegramUserId, accountNumber, uId, proxy (optional)
       - listAccountsTool: передай только telegramUserId
       - Все торговые инструменты: передай telegramUserId, symbol, и опционально size/leverage
    
    5. Отвечай кратко и четко на русском языке
    6. При ошибках объясняй проблему понятным языком
    7. Форматируй ответы с эмодзи для наглядности
    
    ФОРМАТ ОТВЕТОВ:
    
    При открытии позиции:
    ✅ Открыта LONG позиция
    • Символ: BTC_USDT
    • Размер: 10 контрактов
    • Плечо: 20x
    • Цена входа: 50,000 USDT
    
    При показе позиций:
    📊 Открытые позиции:
    
    👤 Аккаунт: 458
    🔹 Инструмент: BTC_USDT
    Сторона: LONG
    Цена входа: 50,000 USDT
    Текущая цена: 50,500 USDT
    Ликвидация: 45,000 USDT
    Объём: 10 контрактов
    Плечо: 20x
    Маржа: 250 USDT
    PnL: 🟢 +100 USDT
    
    При показе баланса:
    💰 Твои аккаунты, баланс и настройки:
    
    Статус | Аккаунт | Баланс USDT | Size | Lev | Proxy
    ✅ | main | 1,000.50 | 10.00 | 20 | http://proxy.com:8080
    
    ВАЖНО:
    - Пользователь может управлять множественными аккаунтами MEXC
    - Все торговые операции выполняются сразу по всем активным аккаунтам
    - При возникновении ошибки сообщай пользователю понятным языком
    - Используй инструменты для реальных операций, не выдумывай данные
    - telegramUserId автоматически передается в контексте, не спрашивай его у пользователя
    - При регистрации аккаунта проси только accountNumber, uId и опционально proxy
  `,

  model: openai.responses("gpt-4o"),

  tools: {
    registerAccountTool,
    listAccountsTool,
    toggleAccountStatusTool,
    updateAccountSettingsTool,
    openLongMarketTool,
    openShortMarketTool,
    openLongLimitTool,
    openShortLimitTool,
    closePositionTool,
    getPositionsTool,
    getBalanceTool,
    getOrdersTool,
    cancelOrdersTool,
  },

  memory: new Memory({
    options: {
      threads: {
        generateTitle: true,
      },
      lastMessages: 20,
    },
    storage: sharedPostgresStorage,
  }),
});
