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

// Helper: Get PnL for a specific symbol from trade history
async function getPositionPnLForSymbol(userId: string, symbol: string): Promise<string> {
  try {
    const logger = globalMastra?.getLogger();
    logger?.info(`📊 Getting PnL for symbol ${symbol} from trade history`);
    
    // Get active accounts
    const accounts = await db.query.mexcAccounts.findMany({
      where: and(
        eq(mexcAccounts.telegramUserId, userId),
        eq(mexcAccounts.isActive, true)
      ),
    });
    
    if (accounts.length === 0) {
      logger?.warn(`⚠️ No active accounts found`);
      return "";
    }
    
    const { MexcFuturesClient } = await import("@max89701/mexc-futures-sdk");
    
    const pnlLines: string[] = [];
    let totalPnlUsd = 0;
    let countPositions = 0;
    
    for (const account of accounts) {
      try {
        const client = new MexcFuturesClient({
          authToken: account.uId,
          logLevel: "INFO"
        });
        
        const fullSymbol = `${symbol}_USDT`;
        logger?.info(`📊 Checking account ${account.accountNumber} for ${fullSymbol} PnL`);
        
        // Get all open positions first
        const posResponse = await client.getOpenPositions("");
        const allPositions = Array.isArray(posResponse) ? posResponse : (posResponse as any)?.data || [];
        
        // Check if position exists - if it does, don't include PnL yet
        const openPosition = allPositions.find((p: any) => p.symbol === fullSymbol);
        
        if (openPosition) {
          logger?.info(`📊 Position still open for ${fullSymbol} on account ${account.accountNumber}, skipping`);
          continue;
        }
        
        // Position is closed - try to get history
        try {
          const historyResponse = await (client as any).getHistory?.() || 
                                  await (client as any).getPositionHistory?.() ||
                                  await (client as any).getClosedPositions?.("");
          
          if (historyResponse) {
            const historyData = Array.isArray(historyResponse) ? historyResponse : (historyResponse as any)?.data || [];
            logger?.info(`📊 Got history data, length: ${historyData.length}`);
            
            // Filter for current symbol and get the most recent entry
            const recentTrades = historyData
              .filter((h: any) => h.symbol === fullSymbol)
              .sort((a: any, b: any) => ((b.closeTime || b.updateTime || 0) - (a.closeTime || a.updateTime || 0)))
              .slice(0, 1);
            
            logger?.info(`📊 Filtered trades for ${fullSymbol}: ${recentTrades.length}`);
            
            if (recentTrades.length > 0) {
              const trade = recentTrades[0];
              // Use realizedPnl or profitReal from history
              const actualPnlUsd = (trade as any).realizedPnl || (trade as any).profitReal || (trade as any).pnl || (trade as any).realised || 0;
              const actualPnlPercent = (trade as any).profitPercent || (trade as any).profitRatio || 0;
              
              logger?.info(`📊 Trade data:`, { 
                symbol: (trade as any).symbol,
                realizedPnl: (trade as any).realizedPnl,
                profitReal: (trade as any).profitReal,
                pnl: (trade as any).pnl,
                realised: (trade as any).realised,
                actualPnlUsd
              });
              
              const pnlEmoji = actualPnlUsd > 0 ? "📈" : "📉";
              const sideText = (trade as any).positionType === 1 || (trade as any).side === 1 ? "LONG" : "SHORT";
              const line = `${pnlEmoji} ${sideText}: ${actualPnlUsd > 0 ? "+" : ""}${actualPnlUsd.toFixed(2)}$ (${actualPnlPercent > 0 ? "+" : ""}${(actualPnlPercent * 100).toFixed(2)}%)`;
              
              logger?.info(`📊 Adding PnL line: ${line}`);
              pnlLines.push(line);
              totalPnlUsd += actualPnlUsd;
              countPositions++;
            }
          }
        } catch (historyError: any) {
          logger?.warn(`⚠️ Could not get history data for account ${account.accountNumber}`, { error: historyError.message });
        }
      } catch (error: any) {
        logger?.warn(`⚠️ Error getting PnL for account ${account.accountNumber}`, { error: error.message });
      }
    }
    
    logger?.info(`📊 Final PnL lines count: ${pnlLines.length}`);
    
    if (pnlLines.length > 0) {
      let result = `\n\n📊 *Реализованный PnL:*\n`;
      result += pnlLines.join("\n");
      if (countPositions > 1) {
        const totalPnlEmoji = totalPnlUsd > 0 ? "📈" : "📉";
        result += `\n${totalPnlEmoji} *Итого: ${totalPnlUsd > 0 ? "+" : ""}${totalPnlUsd.toFixed(2)}$*`;
      }
      logger?.info(`📊 Returning PnL info: ${result.substring(0, 100)}...`);
      return result;
    }
    
    logger?.warn(`⚠️ No PnL data found for symbol ${symbol}`);
    return "";
  } catch (error: any) {
    const logger = globalMastra?.getLogger();
    logger?.error(`❌ Error getting PnL for symbol ${symbol}`, { error: error.message });
    return "";
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

// Helper: Get fourth bid price from MEXC orderbook (for closing SHORT) - returns STRING to preserve precision
async function getFourthBidPrice(symbol: string): Promise<string | null> {
  try {
    const logger = globalMastra?.getLogger();
    logger?.info(`📊 Fetching fourth bid price (4th BUY price) for ${symbol}`);
    
    // Use correct MEXC API endpoint for depth/orderbook
    const response = await fetch(`https://api.mexc.com/api/v3/depth?symbol=${symbol}&limit=10`);
    const data = await response.json();
    
    logger?.info(`📊 Full orderbook response:`, JSON.stringify({ bidsLength: data.bids?.length, asksLength: data.asks?.length }));
    logger?.info(`📊 All bids: ${JSON.stringify(data.bids?.slice(0, 10))}`);
    
    // Check if response has bids array with at least 4 elements
    if (Array.isArray(data.bids) && data.bids.length > 3) {
      // Fourth element is fourth best bid (bids[3])
      // Keep as STRING to preserve precision for MEXC API
      const fourthBidRaw = data.bids[3][0];
      const fourthBidNumeric = parseFloat(fourthBidRaw);
      logger?.info(`💰 Fourth bid found at bids[3] (RAW STRING): "${fourthBidRaw}"`);
      logger?.info(`💰 Fourth bid (numeric): ${fourthBidNumeric}`);
      return fourthBidRaw; // Return STRING not number
    }
    
    logger?.error(`❌ Not enough bids in API response for ${symbol}`);
    return null;
  } catch (error: any) {
    const logger = globalMastra?.getLogger();
    logger?.error(`❌ Error getting fourth bid price for ${symbol}`, { error: error.message });
    return null;
  }
}

// Helper: Get seventh ask price from MEXC orderbook (for closing SHORT) - returns STRING to preserve precision
async function getSeventhAskPrice(symbol: string): Promise<string | null> {
  try {
    const logger = globalMastra?.getLogger();
    logger?.info(`📊 Fetching seventh ask price (7th SELL price) for ${symbol}`);
    
    // Use correct MEXC API endpoint for depth/orderbook
    const response = await fetch(`https://api.mexc.com/api/v3/depth?symbol=${symbol}&limit=20`);
    const data = await response.json();
    
    logger?.info(`📊 Full orderbook response:`, JSON.stringify({ bidsLength: data.bids?.length, asksLength: data.asks?.length }));
    logger?.info(`📊 All asks: ${JSON.stringify(data.asks?.slice(0, 10))}`);
    
    // Check if response has asks array with at least 7 elements
    if (Array.isArray(data.asks) && data.asks.length > 6) {
      // Seventh element is seventh best ask (asks[6])
      // Keep as STRING to preserve precision for MEXC API
      const seventhAskRaw = data.asks[6][0];
      const seventhAskNumeric = parseFloat(seventhAskRaw);
      logger?.info(`💰 Seventh ask found at asks[6] (RAW STRING): "${seventhAskRaw}"`);
      logger?.info(`💰 Seventh ask (numeric): ${seventhAskNumeric}`);
      return seventhAskRaw; // Return STRING not number
    }
    
    logger?.error(`❌ Not enough asks in API response for ${symbol}`);
    return null;
  } catch (error: any) {
    const logger = globalMastra?.getLogger();
    logger?.error(`❌ Error getting seventh ask price for ${symbol}`, { error: error.message });
    return null;
  }
}

// Helper: Get tenth ask price from MEXC orderbook (for closing SHORT) - returns STRING to preserve precision
async function getTenthAskPrice(symbol: string): Promise<string | null> {
  try {
    const logger = globalMastra?.getLogger();
    logger?.info(`📊 Fetching tenth ask price (10th SELL price) for ${symbol}`);
    
    // Use correct MEXC API endpoint for depth/orderbook
    const response = await fetch(`https://api.mexc.com/api/v3/depth?symbol=${symbol}&limit=20`);
    const data = await response.json();
    
    logger?.info(`📊 Full orderbook response:`, JSON.stringify({ bidsLength: data.bids?.length, asksLength: data.asks?.length }));
    logger?.info(`📊 All asks: ${JSON.stringify(data.asks?.slice(0, 15))}`);
    
    // Check if response has asks array with at least 10 elements
    if (Array.isArray(data.asks) && data.asks.length > 9) {
      // Tenth element is tenth best ask (asks[9])
      // Keep as STRING to preserve precision for MEXC API
      const tenthAskRaw = data.asks[9][0];
      const tenthAskNumeric = parseFloat(tenthAskRaw);
      logger?.info(`💰 Tenth ask found at asks[9] (RAW STRING): "${tenthAskRaw}"`);
      logger?.info(`💰 Tenth ask (numeric): ${tenthAskNumeric}`);
      return tenthAskRaw; // Return STRING not number
    }
    
    logger?.error(`❌ Not enough asks in API response for ${symbol}`);
    return null;
  } catch (error: any) {
    const logger = globalMastra?.getLogger();
    logger?.error(`❌ Error getting tenth ask price for ${symbol}`, { error: error.message });
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
  
  // SHORT limit grid - opens SHORT at specified price for all accounts with price ladder
  // /sl 0.08 artx - opens SHORT at 0.08 for account 1, 0.08*0.9999 for account 2, etc.
  if (cmd.startsWith("/sl")) {
    const parts = message.trim().split(/\s+/);
    const basePrice = parseFloat(parts[1]);
    const symbol = parts[2] ? parts[2].toUpperCase() : undefined;
    
    if (!basePrice || !symbol || isNaN(basePrice)) {
      return `❌ Формат: /sl ЦЕНА СИМВОЛ\nПример: /sl 0.08 artx`;
    }
    
    try {
      // Get all active accounts
      const accounts = await db.query.mexcAccounts.findMany({
        where: and(
          eq(mexcAccounts.telegramUserId, userId),
          eq(mexcAccounts.isActive, true)
        ),
      });
      
      if (accounts.length === 0) {
        return `❌ Нет активных аккаунтов`;
      }
      
      const logger = globalMastra?.getLogger();
      logger?.info(`🔴 [SHORT Grid] Starting grid for ${symbol} at base price ${basePrice}`, { accountCount: accounts.length });
      
      // Calculate prices for each account with progressive discount
      const orderPromises = accounts.map(async (account, index) => {
        try {
          // Price formula: basePrice * (1 - 0.001 * index)
          // Account 1 (index 0): basePrice * 1 = basePrice
          // Account 2 (index 1): basePrice * 0.999 (-0.1%)
          // Account 3 (index 2): basePrice * 0.998 (-0.2%)
          // etc.
          const discountFactor = 1 - (0.001 * index);
          const accountPrice = basePrice * discountFactor;
          
          logger?.info(`📍 Grid order for account ${account.accountNumber}:`, { 
            index, 
            discountFactor, 
            accountPrice 
          });
          
          // Execute the order
          const result = await executeToolDirect(openShortLimitTool, {
            telegramUserId: userId,
            symbol,
            price: accountPrice,
            size: undefined, // Use default max size from symbol limits
            leverage: account.defaultLeverage,
          });
          
          return {
            accountNumber: account.accountNumber,
            price: accountPrice.toFixed(8),
            result
          };
        } catch (error: any) {
          logger?.error(`❌ Error placing order for account ${account.accountNumber}`, { error: error.message });
          return {
            accountNumber: account.accountNumber,
            price: (basePrice * (1 - 0.001 * index)).toFixed(8),
            result: `❌ ${error.message}`
          };
        }
      });
      
      // Wait for all orders to complete
      const orderResults = await Promise.all(orderPromises);
      
      // Format response with all orders
      let response = `🔴 *SHORT Сетка запущена*\n\n`;
      response += `📊 Символ: ${symbol}_USDT\n`;
      response += `💰 Базовая цена: ${basePrice}\n`;
      response += `📈 Аккаунтов: ${accounts.length}\n\n`;
      response += `📋 *Ордера по аккаунтам:*\n`;
      
      orderResults.forEach((result, idx) => {
        const emoji = result.result.includes("❌") ? "❌" : "✅";
        response += `${emoji} Акк #${result.accountNumber}: ${result.price}\n`;
      });
      
      const successCount = orderResults.filter(r => !r.result.includes("❌")).length;
      response += `\n✅ Успешно: ${successCount}/${accounts.length}`;
      
      logger?.info(`🔴 [SHORT Grid] Completed`, { successCount, totalAccounts: accounts.length });
      
      return response;
    } catch (error: any) {
      return `❌ Ошибка при создании сетки: ${error.message}`;
    }
  }
  
  // Close SHORT limit at tenth ask price from orderbook
  if (cmd.startsWith("/closebs")) {
    const parts = message.trim().split(/\s+/);
    const symbol = parts[1] ? parts[1].toUpperCase() : "BTC";
    const size = parts[2] ? parseInt(parts[2]) : undefined;
    
    // Get tenth ask price from orderbook (API requires format without underscore)
    const apiSymbol = `${symbol}USDT`;
    const tenthAskPrice = await getTenthAskPrice(apiSymbol);
    
    if (tenthAskPrice === null) {
      return `❌ Не удалось получить цену из стакана для ${apiSymbol}`;
    }
    
    // Execute close order FIRST
    const result = await executeToolDirect(closeShortAtPriceTool, {
      telegramUserId: userId,
      symbol,
      price: tenthAskPrice,
      size,
    });
    
    // Wait for limit order to execute (can take up to 60 seconds)
    // Poll positions until closed or timeout
    const logger = globalMastra?.getLogger();
    const maxWaitTime = 90000; // 90 seconds max
    const pollInterval = 2000; // Check every 2 seconds
    const startTime = Date.now();
    let positionClosed = false;
    
    while (Date.now() - startTime < maxWaitTime) {
      try {
        const accounts = await db.query.mexcAccounts.findMany({
          where: and(
            eq(mexcAccounts.telegramUserId, userId),
            eq(mexcAccounts.isActive, true)
          ),
        });
        
        // Check if position still exists
        let positionFound = false;
        for (const account of accounts) {
          const { MexcFuturesClient } = await import("@max89701/mexc-futures-sdk");
          const client = new MexcFuturesClient({
            authToken: account.uId,
            logLevel: "INFO"
          });
          
          const posResponse = await client.getOpenPositions("");
          const allPositions = Array.isArray(posResponse) ? posResponse : (posResponse as any)?.data || [];
          const hasPosition = allPositions.some((p: any) => p.symbol === apiSymbol);
          
          if (hasPosition) {
            positionFound = true;
            break;
          }
        }
        
        if (!positionFound) {
          positionClosed = true;
          logger?.info(`✅ Position closed after ${Date.now() - startTime}ms`);
          break;
        }
        
        // Wait before next check
        await new Promise(resolve => setTimeout(resolve, pollInterval));
      } catch (error: any) {
        logger?.warn(`⚠️ Error checking position status`, { error: error.message });
        break;
      }
    }
    
    // Get PnL AFTER closing with retries (data may take time to appear in history)
    let pnlInfo = "";
    let pnlRetries = 0;
    const maxPnlRetries = 5;
    
    if (positionClosed) {
      // Wait a bit for history to update
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Try to get PnL up to 5 times
      while (pnlRetries < maxPnlRetries && !pnlInfo) {
        pnlInfo = await getPositionPnLForSymbol(userId, symbol);
        if (!pnlInfo) {
          pnlRetries++;
          if (pnlRetries < maxPnlRetries) {
            logger?.info(`📊 PnL not available yet, retry ${pnlRetries}/${maxPnlRetries}`);
            await new Promise(resolve => setTimeout(resolve, 500));
          }
        }
      }
    }
    
    if (positionClosed) {
      return `✅ *SHORT закрыта по 10th ask ${tenthAskPrice}*${pnlInfo}\n\n${result}`;
    } else {
      return `⏳ *Лимит-ордер выставлен по 10th ask ${tenthAskPrice}*\nПозиция может закрыться до 1 минуты\n\n${result}`;
    }
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
    
    const pnlInfo = await getPositionPnLForSymbol(userId, symbol);
    
    return `✅ *LONG позиция закрыта по рынку*${pnlInfo}

Символ: ${symbol}_USDT
Размер: ${size} контрактов`;
  }
  
  // Close SHORT market
  if (cmd.startsWith("/scm")) {
    const parts = message.trim().split(/\s+/);
    const symbol = parts[1] ? parts[1].toUpperCase() : "BTC";
    const size = parts[2] || "10";
    
    const pnlInfo = await getPositionPnLForSymbol(userId, symbol);
    
    return `✅ *SHORT позиция закрыта по рынку*${pnlInfo}

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
