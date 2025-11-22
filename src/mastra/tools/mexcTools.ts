import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import crypto from "crypto";
import { db } from "../storage/db";
import { mexcAccounts } from "../storage/schema";
import { eq, and } from "drizzle-orm";

/**
 * MEXC Futures Trading Tools
 * 
 * These tools interact with MEXC futures trading platform using WEB-UID authentication
 * WEB-UID is obtained from browser cookies and used to authenticate API requests
 */

// Helper function to create MEXC API signature
function createMexcSignature(params: Record<string, any>, secretKey: string): string {
  const sortedParams = Object.keys(params)
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('&');
  
  return crypto
    .createHmac('sha256', secretKey)
    .update(sortedParams)
    .digest('hex');
}

// Helper function to make authenticated MEXC API calls with u_id
// u_id format: IP:PORT:TOKEN (e.g., 156.246.241.55:63016:uYgG5GfzfZFWGZnW)
export async function mexcApiCall(
  endpoint: string,
  method: string,
  uId: string,
  proxy: string | null,
  params: Record<string, any> = {}
): Promise<any> {
  const baseUrl = "https://contract.mexc.com";
  const timestamp = Date.now();
  
  const requestParams = {
    ...params,
    timestamp,
  };

  // MEXC uses u_id directly as authentication token
  // Format: u_id is set as cookie value
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://contract.mexc.com/",
    "Origin": "https://contract.mexc.com",
    "Accept-Language": "en-US,en;q=0.9",
    "Accept-Encoding": "gzip, deflate, br",
    "Cache-Control": "no-cache",
    "Pragma": "no-cache",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-origin",
    // u_id must be sent as cookie - MEXC validates this for authentication
    "Cookie": `u_id=${uId}`,
  };

  const fetchOptions: RequestInit = {
    method,
    headers,
  };

  if (method === "POST" || method === "PUT") {
    fetchOptions.body = JSON.stringify(requestParams);
  }

  const url = method === "GET" 
    ? `${baseUrl}${endpoint}?${new URLSearchParams(requestParams as any).toString()}`
    : `${baseUrl}${endpoint}`;

  try {
    // Make request with u_id authentication
    const response = await fetch(url, fetchOptions);
    const responseText = await response.text();
    
    console.log(`🔌 MEXC API: ${method} ${endpoint} → ${response.status}`);
    console.log(`   u_id: ${uId.substring(0, 20)}...`);
    console.log(`   Response: ${responseText.substring(0, 200)}`);
    
    if (!response.ok) {
      // Parse error response if possible
      let errorMessage = `MEXC API error: ${response.status} ${response.statusText}`;
      try {
        const errorData = JSON.parse(responseText);
        errorMessage = `MEXC API error: ${response.status} - ${errorData.msg || errorData.message || errorData.description || response.statusText}`;
      } catch (e) {
        errorMessage = `MEXC API error: ${response.status} - ${responseText.substring(0, 100)}`;
      }
      console.error(`❌ ${errorMessage}`);
      throw new Error(errorMessage);
    }

    // Parse response
    try {
      return JSON.parse(responseText);
    } catch (e) {
      throw new Error(`Invalid JSON response from MEXC API: ${responseText.substring(0, 100)}`);
    }
  } catch (error: any) {
    throw new Error(`MEXC API call failed: ${error.message}`);
  }
}

/**
 * Tool: Open Long Market Position
 * Opens a long position at market price on all active accounts
 */
export const openLongMarketTool = createTool({
  id: "open-long-market",
  description: "Opens a LONG market position on MEXC futures for all active accounts",
  inputSchema: z.object({
    telegramUserId: z.string().describe("Telegram user ID"),
    symbol: z.string().describe("Trading pair symbol (e.g., BTC, ETH - without _USDT)"),
    size: z.number().optional().describe("Position size in contracts (optional, uses account default)"),
    leverage: z.number().optional().describe("Leverage multiplier (optional, uses account default)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    results: z.array(z.object({
      accountNumber: z.number(),
      success: z.boolean(),
      orderId: z.string().optional(),
      message: z.string(),
    })),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🟢 [openLongMarketTool] Opening LONG market position', context);

    try {
      // Get all active accounts for this user
      const accounts = await db.query.mexcAccounts.findMany({
        where: and(
          eq(mexcAccounts.telegramUserId, context.telegramUserId),
          eq(mexcAccounts.isActive, true)
        ),
      });

      if (accounts.length === 0) {
        return {
          success: false,
          results: [],
          message: "❌ Нет активных аккаунтов. Используйте /register для добавления аккаунта.",
        };
      }

      const symbol = `${context.symbol}_USDT`;
      const results = [];

      // Execute trade on all active accounts
      for (const account of accounts) {
        try {
          const tradeSize = context.size || account.defaultSize || 10;
          const tradeLeverage = context.leverage || account.defaultLeverage || 20;

          const result = await mexcApiCall(
            "/api/v1/private/order/submit",
            "POST",
            account.uId,
            account.proxy || null,
            {
              symbol,
              side: "BUY",
              type: "MARKET",
              vol: tradeSize,
              leverage: tradeLeverage,
              openType: 1, // Open long
            }
          );

          results.push({
            accountNumber: account.accountNumber,
            success: true,
            orderId: result.data?.orderId || `order-${Date.now()}`,
            message: `✅ Аккаунт ${account.accountNumber}: LONG ${tradeSize} контрактов`,
          });
        } catch (error: any) {
          logger?.error(`❌ [openLongMarketTool] Error for account ${account.accountNumber}`, {
            error: error.message,
          });
          results.push({
            accountNumber: account.accountNumber,
            success: false,
            message: `❌ Аккаунт ${account.accountNumber}: ${error.message}`,
          });
        }
      }

      const successCount = results.filter(r => r.success).length;
      logger?.info('✅ [openLongMarketTool] Completed', { successCount, totalAccounts: accounts.length });

      return {
        success: successCount > 0,
        results,
        message: `Открыто LONG позиций: ${successCount}/${accounts.length} аккаунтов`,
      };
    } catch (error: any) {
      logger?.error('❌ [openLongMarketTool] Error', { error: error.message });
      return {
        success: false,
        results: [],
        message: `Ошибка: ${error.message}`,
      };
    }
  },
});

/**
 * Tool: Open Short Market Position
 * Opens a short position at market price on all active accounts
 */
export const openShortMarketTool = createTool({
  id: "open-short-market",
  description: "Opens a SHORT market position on MEXC futures for all active accounts",
  inputSchema: z.object({
    telegramUserId: z.string().describe("Telegram user ID"),
    symbol: z.string().describe("Trading pair symbol (e.g., BTC, ETH - without _USDT)"),
    size: z.number().optional().describe("Position size in contracts (optional, uses account default)"),
    leverage: z.number().optional().describe("Leverage multiplier (optional, uses account default)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    results: z.array(z.object({
      accountNumber: z.number(),
      success: z.boolean(),
      orderId: z.string().optional(),
      message: z.string(),
    })),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🔴 [openShortMarketTool] Opening SHORT market position', context);

    try {
      // Get all active accounts for this user
      const accounts = await db.query.mexcAccounts.findMany({
        where: and(
          eq(mexcAccounts.telegramUserId, context.telegramUserId),
          eq(mexcAccounts.isActive, true)
        ),
      });

      if (accounts.length === 0) {
        return {
          success: false,
          results: [],
          message: "❌ Нет активных аккаунтов. Используйте /register для добавления аккаунта.",
        };
      }

      const symbol = `${context.symbol}_USDT`;
      const results = [];

      // Execute trade on all active accounts
      for (const account of accounts) {
        try {
          const tradeSize = context.size || account.defaultSize || 10;
          const tradeLeverage = context.leverage || account.defaultLeverage || 20;

          const result = await mexcApiCall(
            "/api/v1/private/order/submit",
            "POST",
            account.uId,
            account.proxy || null,
            {
              symbol,
              side: "SELL",
              type: "MARKET",
              vol: tradeSize,
              leverage: tradeLeverage,
              openType: 2, // Open short
            }
          );

          results.push({
            accountNumber: account.accountNumber,
            success: true,
            orderId: result.data?.orderId || `order-${Date.now()}`,
            message: `✅ Аккаунт ${account.accountNumber}: SHORT ${tradeSize} контрактов`,
          });
        } catch (error: any) {
          logger?.error(`❌ [openShortMarketTool] Error for account ${account.accountNumber}`, {
            error: error.message,
          });
          results.push({
            accountNumber: account.accountNumber,
            success: false,
            message: `❌ Аккаунт ${account.accountNumber}: ${error.message}`,
          });
        }
      }

      const successCount = results.filter(r => r.success).length;
      logger?.info('✅ [openShortMarketTool] Completed', { successCount, totalAccounts: accounts.length });

      return {
        success: successCount > 0,
        results,
        message: `Открыто SHORT позиций: ${successCount}/${accounts.length} аккаунтов`,
      };
    } catch (error: any) {
      logger?.error('❌ [openShortMarketTool] Error', { error: error.message });
      return {
        success: false,
        results: [],
        message: `Ошибка: ${error.message}`,
      };
    }
  },
});

/**
 * Tool: Open Long Limit Position
 * Opens a long position at specified limit price on all active accounts
 */
export const openLongLimitTool = createTool({
  id: "open-long-limit",
  description: "Opens a LONG limit position on MEXC futures at specified price for all active accounts",
  inputSchema: z.object({
    telegramUserId: z.string().describe("Telegram user ID"),
    price: z.number().describe("Limit price for entry"),
    symbol: z.string().describe("Trading pair symbol (e.g., BTC, ETH - without _USDT)"),
    size: z.number().optional().describe("Position size in contracts (optional, uses account default)"),
    leverage: z.number().optional().describe("Leverage multiplier (optional, uses account default)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    results: z.array(z.object({
      accountNumber: z.number(),
      success: z.boolean(),
      orderId: z.string().optional(),
      message: z.string(),
    })),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🟢 [openLongLimitTool] Opening LONG limit position', context);

    try {
      // Get all active accounts for this user
      const accounts = await db.query.mexcAccounts.findMany({
        where: and(
          eq(mexcAccounts.telegramUserId, context.telegramUserId),
          eq(mexcAccounts.isActive, true)
        ),
      });

      if (accounts.length === 0) {
        return {
          success: false,
          results: [],
          message: "❌ Нет активных аккаунтов. Используйте /register для добавления аккаунта.",
        };
      }

      const symbol = `${context.symbol}_USDT`;
      const results = [];

      // Execute trade on all active accounts
      for (const account of accounts) {
        try {
          const tradeSize = context.size || account.defaultSize || 10;
          const tradeLeverage = context.leverage || account.defaultLeverage || 20;

          const result = await mexcApiCall(
            "/api/v1/private/order/submit",
            "POST",
            account.uId,
            account.proxy || null,
            {
              symbol,
              side: "BUY",
              type: "LIMIT",
              price: context.price,
              vol: tradeSize,
              leverage: tradeLeverage,
              openType: 1,
            }
          );

          results.push({
            accountNumber: account.accountNumber,
            success: true,
            orderId: result.data?.orderId || `order-${Date.now()}`,
            message: `✅ Аккаунт ${account.accountNumber}: LONG лимит ${tradeSize} контрактов по ${context.price}`,
          });
        } catch (error: any) {
          logger?.error(`❌ [openLongLimitTool] Error for account ${account.accountNumber}`, {
            error: error.message,
          });
          results.push({
            accountNumber: account.accountNumber,
            success: false,
            message: `❌ Аккаунт ${account.accountNumber}: ${error.message}`,
          });
        }
      }

      const successCount = results.filter(r => r.success).length;
      logger?.info('✅ [openLongLimitTool] Completed', { successCount, totalAccounts: accounts.length });

      return {
        success: successCount > 0,
        results,
        message: `Размещено LONG лимитов: ${successCount}/${accounts.length} аккаунтов`,
      };
    } catch (error: any) {
      logger?.error('❌ [openLongLimitTool] Error', { error: error.message });
      return {
        success: false,
        results: [],
        message: `Ошибка: ${error.message}`,
      };
    }
  },
});

/**
 * Tool: Open Short Limit Position
 * Opens a short position at specified limit price on all active accounts
 */
export const openShortLimitTool = createTool({
  id: "open-short-limit",
  description: "Opens a SHORT limit position on MEXC futures at specified price for all active accounts",
  inputSchema: z.object({
    telegramUserId: z.string().describe("Telegram user ID"),
    price: z.number().describe("Limit price for entry"),
    symbol: z.string().describe("Trading pair symbol (e.g., BTC, ETH - without _USDT)"),
    size: z.number().optional().describe("Position size in contracts (optional, uses account default)"),
    leverage: z.number().optional().describe("Leverage multiplier (optional, uses account default)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    results: z.array(z.object({
      accountNumber: z.number(),
      success: z.boolean(),
      orderId: z.string().optional(),
      message: z.string(),
    })),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🔴 [openShortLimitTool] Opening SHORT limit position', context);

    try {
      // Get all active accounts for this user
      const accounts = await db.query.mexcAccounts.findMany({
        where: and(
          eq(mexcAccounts.telegramUserId, context.telegramUserId),
          eq(mexcAccounts.isActive, true)
        ),
      });

      if (accounts.length === 0) {
        return {
          success: false,
          results: [],
          message: "❌ Нет активных аккаунтов. Используйте /register для добавления аккаунта.",
        };
      }

      const symbol = `${context.symbol}_USDT`;
      const results = [];

      // Execute trade on all active accounts
      for (const account of accounts) {
        try {
          const tradeSize = context.size || account.defaultSize || 10;
          const tradeLeverage = context.leverage || account.defaultLeverage || 20;

          const result = await mexcApiCall(
            "/api/v1/private/order/submit",
            "POST",
            account.uId,
            account.proxy || null,
            {
              symbol,
              side: "SELL",
              type: "LIMIT",
              price: context.price,
              vol: tradeSize,
              leverage: tradeLeverage,
              openType: 2,
            }
          );

          results.push({
            accountNumber: account.accountNumber,
            success: true,
            orderId: result.data?.orderId || `order-${Date.now()}`,
            message: `✅ Аккаунт ${account.accountNumber}: SHORT лимит ${tradeSize} контрактов по ${context.price}`,
          });
        } catch (error: any) {
          logger?.error(`❌ [openShortLimitTool] Error for account ${account.accountNumber}`, {
            error: error.message,
          });
          results.push({
            accountNumber: account.accountNumber,
            success: false,
            message: `❌ Аккаунт ${account.accountNumber}: ${error.message}`,
          });
        }
      }

      const successCount = results.filter(r => r.success).length;
      logger?.info('✅ [openShortLimitTool] Completed', { successCount, totalAccounts: accounts.length });

      return {
        success: successCount > 0,
        results,
        message: `Размещено SHORT лимитов: ${successCount}/${accounts.length} аккаунтов`,
      };
    } catch (error: any) {
      logger?.error('❌ [openShortLimitTool] Error', { error: error.message });
      return {
        success: false,
        results: [],
        message: `Ошибка: ${error.message}`,
      };
    }
  },
});

/**
 * Tool: Close Position
 * Closes an open position at market price on all active accounts
 */
export const closePositionTool = createTool({
  id: "close-position",
  description: "Closes an open position at market price for specified symbol on all active accounts",
  inputSchema: z.object({
    telegramUserId: z.string().describe("Telegram user ID"),
    symbol: z.string().describe("Trading pair symbol (e.g., BTC, ETH - without _USDT)"),
    size: z.number().optional().describe("Size to close (optional, closes entire position if not provided)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    results: z.array(z.object({
      accountNumber: z.number(),
      success: z.boolean(),
      orderId: z.string().optional(),
      message: z.string(),
    })),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🧹 [closePositionTool] Closing position', context);

    try {
      // Get all active accounts for this user
      const accounts = await db.query.mexcAccounts.findMany({
        where: and(
          eq(mexcAccounts.telegramUserId, context.telegramUserId),
          eq(mexcAccounts.isActive, true)
        ),
      });

      if (accounts.length === 0) {
        return {
          success: false,
          results: [],
          message: "❌ Нет активных аккаунтов. Используйте /register для добавления аккаунта.",
        };
      }

      const symbol = `${context.symbol}_USDT`;
      const results = [];

      // Execute close on all active accounts
      for (const account of accounts) {
        try {
          // First, get current position to determine side
          const positions = await mexcApiCall(
            "/api/v1/private/position/list",
            "GET",
            account.uId,
            account.proxy || null,
            { symbol }
          );

          // Find the position
          const position = positions.data?.find((p: any) => p.symbol === symbol);
          
          if (!position || position.holdVol === 0) {
            results.push({
              accountNumber: account.accountNumber,
              success: false,
              message: `⚠️ Аккаунт ${account.accountNumber}: Нет открытой позиции для ${context.symbol}`,
            });
            continue;
          }

          // Close the position (opposite side of current position)
          const closeSide = position.positionType === 1 ? "SELL" : "BUY";
          const closeSize = context.size || position.holdVol;

          const result = await mexcApiCall(
            "/api/v1/private/order/submit",
            "POST",
            account.uId,
            account.proxy || null,
            {
              symbol,
              side: closeSide,
              type: "MARKET",
              vol: closeSize,
              closeType: 3, // Close position
            }
          );

          results.push({
            accountNumber: account.accountNumber,
            success: true,
            orderId: result.data?.orderId || `order-${Date.now()}`,
            message: `✅ Аккаунт ${account.accountNumber}: Закрыто ${closeSize} контрактов`,
          });
        } catch (error: any) {
          logger?.error(`❌ [closePositionTool] Error for account ${account.accountNumber}`, {
            error: error.message,
          });
          results.push({
            accountNumber: account.accountNumber,
            success: false,
            message: `❌ Аккаунт ${account.accountNumber}: ${error.message}`,
          });
        }
      }

      const successCount = results.filter(r => r.success).length;
      logger?.info('✅ [closePositionTool] Completed', { successCount, totalAccounts: accounts.length });

      return {
        success: successCount > 0,
        results,
        message: `Закрыто позиций: ${successCount}/${accounts.length} аккаунтов`,
      };
    } catch (error: any) {
      logger?.error('❌ [closePositionTool] Error', { error: error.message });
      return {
        success: false,
        results: [],
        message: `Ошибка: ${error.message}`,
      };
    }
  },
});

/**
 * Tool: Get Open Positions
 * Retrieves all open positions for all active accounts
 */
export const getPositionsTool = createTool({
  id: "get-positions",
  description: "Retrieves all open positions for all active accounts",
  inputSchema: z.object({
    telegramUserId: z.string().describe("Telegram user ID"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    positions: z.array(z.object({
      accountNumber: z.number(),
      symbol: z.string(),
      side: z.string(),
      entryPrice: z.number(),
      currentPrice: z.number(),
      liquidationPrice: z.number(),
      size: z.number(),
      leverage: z.number(),
      pnl: z.number(),
      margin: z.number(),
    })).optional(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('📦 [getPositionsTool] Fetching open positions', context);

    try {
      // Get all active accounts for this user
      const accounts = await db.query.mexcAccounts.findMany({
        where: and(
          eq(mexcAccounts.telegramUserId, context.telegramUserId),
          eq(mexcAccounts.isActive, true)
        ),
      });

      if (accounts.length === 0) {
        return {
          success: false,
          positions: [],
          message: "❌ Нет активных аккаунтов. Используйте /register для добавления аккаунта.",
        };
      }

      const allPositions = [];

      // Fetch positions from all active accounts
      for (const account of accounts) {
        try {
          const result = await mexcApiCall(
            "/api/v1/private/position/list",
            "GET",
            account.uId,
            account.proxy || null,
            {}
          );

          const accountPositions = (result.data || [])
            .filter((p: any) => p.holdVol > 0)
            .map((p: any) => ({
              accountNumber: account.accountNumber,
              symbol: p.symbol,
              side: p.positionType === 1 ? "LONG" : "SHORT",
              entryPrice: p.openAvgPrice,
              currentPrice: p.fairPrice,
              liquidationPrice: p.liquidatePrice,
              size: p.holdVol,
              leverage: p.leverage,
              pnl: p.unrealisedPnl,
              margin: p.margin,
            }));

          allPositions.push(...accountPositions);
        } catch (error: any) {
          logger?.error(`❌ [getPositionsTool] Error for account ${account.accountNumber}`, {
            error: error.message,
          });
        }
      }

      logger?.info('✅ [getPositionsTool] Positions retrieved successfully', { 
        totalPositions: allPositions.length,
        totalAccounts: accounts.length 
      });

      return {
        success: true,
        positions: allPositions,
        message: `Найдено ${allPositions.length} открытых позиций на ${accounts.length} аккаунтах`,
      };
    } catch (error: any) {
      logger?.error('❌ [getPositionsTool] Error', { error: error.message });
      return {
        success: false,
        positions: [],
        message: `Ошибка: ${error.message}`,
      };
    }
  },
});

/**
 * Tool: Get Account Balance
 * Retrieves balance and account information for all active MEXC accounts
 */
export const getBalanceTool = createTool({
  id: "get-balance",
  description: "Retrieves balance and account information for all active MEXC accounts",
  inputSchema: z.object({
    telegramUserId: z.string().describe("Telegram user ID"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    accounts: z.array(z.object({
      accountNumber: z.number(),
      status: z.string(),
      balance: z.number(),
      leverage: z.number(),
      size: z.number(),
      proxy: z.string().optional(),
    })).optional(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('💰 [getBalanceTool] Fetching account balance', context);

    try {
      // Get all active accounts for this user
      const accounts = await db.query.mexcAccounts.findMany({
        where: and(
          eq(mexcAccounts.telegramUserId, context.telegramUserId),
          eq(mexcAccounts.isActive, true)
        ),
      });

      if (accounts.length === 0) {
        return {
          success: false,
          accounts: [],
          message: "❌ Нет активных аккаунтов. Используйте /register для добавления аккаунта.",
        };
      }

      const allBalances = [];

      // Fetch balance from all active accounts
      for (const account of accounts) {
        try {
          const result = await mexcApiCall(
            "/api/v1/private/account/assets",
            "GET",
            account.uId,
            account.proxy || null,
            {}
          );

          allBalances.push({
            accountNumber: account.accountNumber,
            status: "✅ Активен",
            balance: result.data?.availableBalance || 0,
            leverage: account.defaultLeverage || 20,
            size: account.defaultSize || 10,
            proxy: account.proxy || undefined,
          });
        } catch (error: any) {
          logger?.error(`❌ [getBalanceTool] Error for account ${account.accountNumber}`, {
            error: error.message,
          });
          allBalances.push({
            accountNumber: account.accountNumber,
            status: "❌ Ошибка",
            balance: 0,
            leverage: account.defaultLeverage || 20,
            size: account.defaultSize || 10,
            proxy: account.proxy || undefined,
          });
        }
      }

      const totalBalance = allBalances.reduce((sum, acc) => sum + acc.balance, 0);
      logger?.info('✅ [getBalanceTool] Balances retrieved successfully', { 
        totalAccounts: accounts.length,
        totalBalance 
      });

      return {
        success: true,
        accounts: allBalances,
        message: `Общий баланс: ${totalBalance.toFixed(2)} USDT на ${accounts.length} аккаунтах`,
      };
    } catch (error: any) {
      logger?.error('❌ [getBalanceTool] Error', { error: error.message });
      return {
        success: false,
        accounts: [],
        message: `Ошибка: ${error.message}`,
      };
    }
  },
});

/**
 * Tool: Get Open Orders
 * Retrieves all open orders for all active accounts
 */
export const getOrdersTool = createTool({
  id: "get-orders",
  description: "Retrieves all open orders for specified symbol or all symbols across all active accounts",
  inputSchema: z.object({
    telegramUserId: z.string().describe("Telegram user ID"),
    symbol: z.string().optional().describe("Trading pair symbol (optional, returns all if not provided)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    orders: z.array(z.object({
      accountNumber: z.number(),
      orderId: z.string(),
      symbol: z.string(),
      side: z.string(),
      type: z.string(),
      price: z.number(),
      size: z.number(),
      filled: z.number(),
    })).optional(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('📋 [getOrdersTool] Fetching open orders', context);

    try {
      // Get all active accounts for this user
      const accounts = await db.query.mexcAccounts.findMany({
        where: and(
          eq(mexcAccounts.telegramUserId, context.telegramUserId),
          eq(mexcAccounts.isActive, true)
        ),
      });

      if (accounts.length === 0) {
        return {
          success: false,
          orders: [],
          message: "❌ Нет активных аккаунтов. Используйте /register для добавления аккаунта.",
        };
      }

      const allOrders = [];
      const params: any = {};
      if (context.symbol) {
        params.symbol = `${context.symbol}_USDT`;
      }

      // Fetch orders from all active accounts
      for (const account of accounts) {
        try {
          const result = await mexcApiCall(
            "/api/v1/private/order/list/open_orders",
            "GET",
            account.uId,
            account.proxy || null,
            params
          );

          const accountOrders = (result.data || []).map((o: any) => ({
            accountNumber: account.accountNumber,
            orderId: o.orderId,
            symbol: o.symbol,
            side: o.side,
            type: o.orderType,
            price: o.price,
            size: o.vol,
            filled: o.dealVol,
          }));

          allOrders.push(...accountOrders);
        } catch (error: any) {
          logger?.error(`❌ [getOrdersTool] Error for account ${account.accountNumber}`, {
            error: error.message,
          });
        }
      }

      logger?.info('✅ [getOrdersTool] Orders retrieved successfully', { 
        totalOrders: allOrders.length,
        totalAccounts: accounts.length 
      });

      return {
        success: true,
        orders: allOrders,
        message: `Найдено ${allOrders.length} открытых ордеров на ${accounts.length} аккаунтах`,
      };
    } catch (error: any) {
      logger?.error('❌ [getOrdersTool] Error', { error: error.message });
      return {
        success: false,
        orders: [],
        message: `Ошибка: ${error.message}`,
      };
    }
  },
});

/**
 * Tool: Cancel Orders
 * Cancels all open orders for a symbol on all active accounts
 */
export const cancelOrdersTool = createTool({
  id: "cancel-orders",
  description: "Cancels all open orders for specified trading symbol on all active accounts",
  inputSchema: z.object({
    telegramUserId: z.string().describe("Telegram user ID"),
    symbol: z.string().describe("Trading pair symbol (e.g., BTC, ETH - without _USDT)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    results: z.array(z.object({
      accountNumber: z.number(),
      success: z.boolean(),
      cancelledCount: z.number().optional(),
      message: z.string(),
    })),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('❌ [cancelOrdersTool] Cancelling orders', context);

    try {
      // Get all active accounts for this user
      const accounts = await db.query.mexcAccounts.findMany({
        where: and(
          eq(mexcAccounts.telegramUserId, context.telegramUserId),
          eq(mexcAccounts.isActive, true)
        ),
      });

      if (accounts.length === 0) {
        return {
          success: false,
          results: [],
          message: "❌ Нет активных аккаунтов. Используйте /register для добавления аккаунта.",
        };
      }

      const symbol = `${context.symbol}_USDT`;
      const results = [];

      // Cancel orders on all active accounts
      for (const account of accounts) {
        try {
          const result = await mexcApiCall(
            "/api/v1/private/order/cancel_all",
            "POST",
            account.uId,
            account.proxy || null,
            { symbol }
          );

          results.push({
            accountNumber: account.accountNumber,
            success: true,
            cancelledCount: result.data?.cancelledCount || 0,
            message: `✅ Аккаунт ${account.accountNumber}: Отменено ${result.data?.cancelledCount || 0} ордеров`,
          });
        } catch (error: any) {
          logger?.error(`❌ [cancelOrdersTool] Error for account ${account.accountNumber}`, {
            error: error.message,
          });
          results.push({
            accountNumber: account.accountNumber,
            success: false,
            message: `❌ Аккаунт ${account.accountNumber}: ${error.message}`,
          });
        }
      }

      const successCount = results.filter(r => r.success).length;
      const totalCancelled = results.reduce((sum, r) => sum + (r.cancelledCount || 0), 0);
      logger?.info('✅ [cancelOrdersTool] Completed', { 
        successCount, 
        totalAccounts: accounts.length,
        totalCancelled 
      });

      return {
        success: successCount > 0,
        results,
        message: `Отменено ${totalCancelled} ордеров на ${successCount}/${accounts.length} аккаунтах`,
      };
    } catch (error: any) {
      logger?.error('❌ [cancelOrdersTool] Error', { error: error.message });
      return {
        success: false,
        results: [],
        message: `Ошибка: ${error.message}`,
      };
    }
  },
});
