import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { MexcFuturesClient } from "@max89701/mexc-futures-sdk";
import { db } from "../storage/db";
import { mexcAccounts, symbolLimits } from "../storage/schema";
import { eq, and } from "drizzle-orm";

/**
 * MEXC Futures Trading Tools
 * 
 * These tools interact with MEXC futures trading platform using the official SDK
 * Authentication uses u_id from browser cookies
 */

// Helper function to create MEXC client from u_id
function createMexcClient(uId: string): MexcFuturesClient {
  return new MexcFuturesClient({
    authToken: uId,
    logLevel: "INFO"
  });
}

// Helper: Get max contract limit for a symbol (from DB or MEXC API)
async function getSymbolLimit(symbol: string, logger?: any): Promise<number> {
  try {
    // Try to get from database first
    const limit = await db.query.symbolLimits.findFirst({
      where: eq(symbolLimits.symbol, symbol),
    });
    
    if (limit) {
      logger?.info(`📊 Symbol ${symbol} max contracts (from DB): ${limit.maxContracts}`);
      return limit.maxContracts;
    }
    
    // If not in DB, fetch from MEXC API - get all contracts and find the one we need
    logger?.info(`🔍 Symbol ${symbol} not in DB, fetching from MEXC API...`);
    const response = await fetch('https://contract.mexc.com/api/v1/contract/detail');
    const data = await response.json();
    
    if (data.success && Array.isArray(data.data)) {
      // Find the contract matching our symbol
      const contract = data.data.find((c: any) => c.symbol === symbol);
      
      if (contract && contract.maxVol) {
        const maxContracts = parseInt(contract.maxVol) || 100;
        
        // Cache it in DB for future use
        try {
          await db.insert(symbolLimits).values({
            symbol,
            maxContracts,
          }).onConflictDoNothing();
          logger?.info(`💾 Cached ${symbol} limit ${maxContracts} to DB`);
        } catch (e) {
          logger?.warn(`⚠️ Could not cache to DB`, { error: (e as any).message });
        }
        
        logger?.info(`📊 Symbol ${symbol} max contracts (from MEXC): ${maxContracts}`);
        return maxContracts;
      }
    }
    
    logger?.warn(`⚠️ Could not fetch ${symbol} from MEXC API, using default 100`);
    return 100; // Default to 100 if API fails
  } catch (error: any) {
    logger?.warn(`⚠️ Error getting symbol limit for ${symbol}`, { error: error.message });
    return 100; // Default to 100
  }
}



/**
 * Tool: Open Long Market Position
 */
export const openLongMarketTool = createTool({
  id: "open-long-market",
  description: "Opens a LONG market position on MEXC futures for all active accounts",
  inputSchema: z.object({
    telegramUserId: z.string().describe("Telegram user ID"),
    symbol: z.string().describe("Trading pair symbol (e.g., BTC, ETH - without _USDT)"),
    size: z.number().optional().describe("Position size in contracts"),
    leverage: z.number().optional().describe("Leverage multiplier"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🟢 [openLongMarketTool] Opening LONG market position', context);

    try {
      const accounts = await db.query.mexcAccounts.findMany({
        where: and(
          eq(mexcAccounts.telegramUserId, context.telegramUserId),
          eq(mexcAccounts.isActive, true)
        ),
      });

      if (accounts.length === 0) {
        return {
          success: false,
          message: "❌ Нет активных аккаунтов. Используйте /register для добавления аккаунта.",
        };
      }

      const symbol = `${context.symbol}_USDT`;
      const results: string[] = [];

      for (const account of accounts) {
        try {
          logger?.info(`🔌 Opening position on account ${account.accountNumber}`, { symbol });
          const client = createMexcClient(account.uId);
          const tradeLeverage = context.leverage || account.defaultLeverage || 20;
          
          // Get size: use custom size, or symbol limit as maximum
          let tradeSize = context.size;
          if (!tradeSize) {
            const symbolMax = await getSymbolLimit(symbol, logger);
            tradeSize = symbolMax; // Open at maximum allowed for this symbol
            logger?.info(`💡 Opening at max allowed size`, { tradeSize, symbolMax });
          }

          logger?.info(`📍 Submitting order`, { symbol, size: tradeSize, leverage: tradeLeverage });
          
          await client.submitOrder({
            symbol,
            side: 1,
            vol: tradeSize,
            type: 5,
            price: 0,
            leverage: tradeLeverage,
            openType: 2,
          });

          results.push(`✅ Аккаунт ${account.accountNumber}: LONG ${tradeSize} контрактов`);
        } catch (error: any) {
          logger?.error(`❌ Error for account ${account.accountNumber}`, { error: error.message });
          results.push(`❌ Аккаунт ${account.accountNumber}: ${error.message}`);
        }
      }

      return {
        success: results.some(r => r.includes("✅")),
        message: results.join("\n"),
      };
    } catch (error: any) {
      logger?.error('❌ [openLongMarketTool] Error', { error: error.message });
      return {
        success: false,
        message: `Ошибка: ${error.message}`,
      };
    }
  },
});

/**
 * Tool: Open Short Market Position
 */
export const openShortMarketTool = createTool({
  id: "open-short-market",
  description: "Opens a SHORT market position on MEXC futures for all active accounts",
  inputSchema: z.object({
    telegramUserId: z.string().describe("Telegram user ID"),
    symbol: z.string().describe("Trading pair symbol"),
    size: z.number().optional().describe("Position size"),
    leverage: z.number().optional().describe("Leverage"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🔴 [openShortMarketTool] Opening SHORT market position', context);

    try {
      const accounts = await db.query.mexcAccounts.findMany({
        where: and(
          eq(mexcAccounts.telegramUserId, context.telegramUserId),
          eq(mexcAccounts.isActive, true)
        ),
      });

      if (accounts.length === 0) {
        return {
          success: false,
          message: "❌ Нет активных аккаунтов",
        };
      }

      const symbol = `${context.symbol}_USDT`;
      const results: string[] = [];

      for (const account of accounts) {
        try {
          const client = createMexcClient(account.uId);
          const tradeLeverage = context.leverage || account.defaultLeverage || 20;
          
          // Get size: use custom size, or symbol limit as maximum
          let tradeSize = context.size;
          if (!tradeSize) {
            const symbolMax = await getSymbolLimit(symbol, logger);
            tradeSize = symbolMax; // Open at maximum allowed for this symbol
            logger?.info(`💡 Opening at max allowed size`, { tradeSize, symbolMax });
          }

          logger?.info(`📍 Submitting order`, { symbol, size: tradeSize, leverage: tradeLeverage });

          await client.submitOrder({
            symbol,
            side: 3,
            vol: tradeSize,
            type: 5,
            price: 0,
            leverage: tradeLeverage,
            openType: 2,
          });

          results.push(`✅ Аккаунт ${account.accountNumber}: SHORT ${tradeSize} контрактов`);
        } catch (error: any) {
          results.push(`❌ Аккаунт ${account.accountNumber}: ${error.message}`);
        }
      }

      return {
        success: results.some(r => r.includes("✅")),
        message: results.join("\n"),
      };
    } catch (error: any) {
      logger?.error('❌ Error', { error: error.message });
      return {
        success: false,
        message: `Ошибка: ${error.message}`,
      };
    }
  },
});

/**
 * Tool: Open Long Limit Position
 */
export const openLongLimitTool = createTool({
  id: "open-long-limit",
  description: "Opens a LONG limit position on MEXC futures",
  inputSchema: z.object({
    telegramUserId: z.string(),
    symbol: z.string(),
    price: z.number(),
    size: z.number().optional(),
    leverage: z.number().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🟢 [openLongLimitTool] Opening LONG limit position', context);

    try {
      const accounts = await db.query.mexcAccounts.findMany({
        where: and(
          eq(mexcAccounts.telegramUserId, context.telegramUserId),
          eq(mexcAccounts.isActive, true)
        ),
      });

      if (accounts.length === 0) {
        return { success: false, message: "❌ Нет активных аккаунтов" };
      }

      const symbol = `${context.symbol}_USDT`;
      const results: string[] = [];

      for (const account of accounts) {
        try {
          const client = createMexcClient(account.uId);
          const tradeLeverage = context.leverage || account.defaultLeverage || 20;
          
          // Get size: use custom size, or symbol limit as maximum
          let tradeSize = context.size;
          if (!tradeSize) {
            const symbolMax = await getSymbolLimit(symbol, logger);
            tradeSize = symbolMax; // Open at maximum allowed for this symbol
            logger?.info(`💡 Opening limit at max allowed size`, { tradeSize, symbolMax });
          }
          
          logger?.info(`📍 Submitting limit order`, { symbol, price: context.price, size: tradeSize, leverage: tradeLeverage });
          
          await client.submitOrder({
            symbol,
            side: 1,
            vol: tradeSize,
            type: 1,
            price: context.price,
            leverage: tradeLeverage,
            openType: 2,
          });
          results.push(`✅ Аккаунт ${account.accountNumber}: LONG лимит ${context.price}, ${tradeSize} контрактов`);
        } catch (error: any) {
          logger?.error(`❌ Error submitting LONG limit order for account ${account.accountNumber}`, { error: error.message });
          results.push(`❌ Аккаунт ${account.accountNumber}: ${error.message}`);
        }
      }

      return { success: results.some(r => r.includes("✅")), message: results.join("\n") };
    } catch (error: any) {
      return { success: false, message: `Ошибка: ${error.message}` };
    }
  },
});

/**
 * Tool: Open Short Limit Position
 */
export const openShortLimitTool = createTool({
  id: "open-short-limit",
  description: "Opens a SHORT limit position on MEXC futures",
  inputSchema: z.object({
    telegramUserId: z.string(),
    symbol: z.string(),
    price: z.number(),
    size: z.number().optional(),
    leverage: z.number().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🔴 [openShortLimitTool] Opening SHORT limit position', context);

    try {
      const accounts = await db.query.mexcAccounts.findMany({
        where: and(
          eq(mexcAccounts.telegramUserId, context.telegramUserId),
          eq(mexcAccounts.isActive, true)
        ),
      });

      if (accounts.length === 0) {
        return { success: false, message: "❌ Нет активных аккаунтов" };
      }

      const symbol = `${context.symbol}_USDT`;
      const results: string[] = [];

      for (const account of accounts) {
        try {
          const client = createMexcClient(account.uId);
          const tradeLeverage = context.leverage || account.defaultLeverage || 20;
          
          // Get size: use custom size, or symbol limit as maximum
          let tradeSize = context.size;
          if (!tradeSize) {
            const symbolMax = await getSymbolLimit(symbol, logger);
            tradeSize = symbolMax; // Open at maximum allowed for this symbol
            logger?.info(`💡 Opening limit at max allowed size`, { tradeSize, symbolMax });
          }
          
          logger?.info(`📍 Submitting limit order`, { symbol, price: context.price, size: tradeSize, leverage: tradeLeverage });
          
          await client.submitOrder({
            symbol,
            side: 3,
            vol: tradeSize,
            type: 1,
            price: context.price,
            leverage: tradeLeverage,
            openType: 2,
          });
          results.push(`✅ Аккаунт ${account.accountNumber}: SHORT лимит ${context.price}, ${tradeSize} контрактов`);
        } catch (error: any) {
          logger?.error(`❌ Error submitting SHORT limit order for account ${account.accountNumber}`, { error: error.message });
          results.push(`❌ Аккаунт ${account.accountNumber}: ${error.message}`);
        }
      }

      return { success: results.some(r => r.includes("✅")), message: results.join("\n") };
    } catch (error: any) {
      return { success: false, message: `Ошибка: ${error.message}` };
    }
  },
});

/**
 * Tool: Close Position
 */
export const closePositionTool = createTool({
  id: "close-position",
  description: "Closes a position on all active accounts",
  inputSchema: z.object({
    telegramUserId: z.string(),
    symbol: z.string(),
    size: z.number().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🔵 [closePositionTool] Closing position', context);

    try {
      const accounts = await db.query.mexcAccounts.findMany({
        where: and(
          eq(mexcAccounts.telegramUserId, context.telegramUserId),
          eq(mexcAccounts.isActive, true)
        ),
      });

      if (accounts.length === 0) {
        return { success: false, message: "❌ Нет активных аккаунтов" };
      }

      const symbol = `${context.symbol}_USDT`;
      const results: string[] = [];

      for (const account of accounts) {
        try {
          const client = createMexcClient(account.uId);
          // Get all positions (pass empty string to get all)
          const posResponse = await client.getOpenPositions("");
          
          // Extract data array from response object
          let allPositions: any[] = [];
          if (posResponse && typeof posResponse === 'object' && Array.isArray(posResponse.data)) {
            allPositions = posResponse.data;
          } else if (Array.isArray(posResponse)) {
            allPositions = posResponse;
          }
          
          logger?.info(`📍 Got positions response`, { allPositionsLength: allPositions.length });
          
          // Log all positions to see what we have
          if (allPositions.length > 0) {
            logger?.info(`📋 All open positions:`, allPositions.map((p: any) => ({ symbol: p.symbol, holdVol: p.holdVol })));
          }
          
          // Filter for our symbol
          const positions = allPositions.filter((pos: any) => pos.symbol === symbol);
          
          logger?.info(`🔍 Filtered positions for ${symbol}:`, { filteredCount: positions.length });

          if (positions.length === 0) {
            results.push(`⚠️ Аккаунт ${account.accountNumber}: нет открытых позиций по ${symbol}`);
            continue;
          }

          for (const pos of positions) {
            const closeSize = context.size || Math.abs((pos as any).holdVol);
            // positionType: 1 = LONG, 2 = SHORT
            // closeSide: 4 = close LONG, 2 = close SHORT
            const closeSide = (pos as any).positionType === 1 ? 4 : 2;

            logger?.info(`📍 Closing position`, { symbol, closeSize, closeSide, positionType: (pos as any).positionType });

            await client.submitOrder({
              symbol,
              side: closeSide,
              vol: closeSize,
              type: 5,
              price: 0,
              openType: 2,
            });

            results.push(`✅ Аккаунт ${account.accountNumber}: закрыта позиция ${closeSize} контрактов`);
          }
        } catch (error: any) {
          logger?.error(`❌ Error closing position for account ${account.accountNumber}`, { error: error.message });
          results.push(`❌ Аккаунт ${account.accountNumber}: ${error.message}`);
        }
      }

      return { success: results.some(r => r.includes("✅")), message: results.join("\n") };
    } catch (error: any) {
      return { success: false, message: `Ошибка: ${error.message}` };
    }
  },
});

/**
 * Tool: Get Positions
 */
export const getPositionsTool = createTool({
  id: "get-positions",
  description: "Get all open positions",
  inputSchema: z.object({
    telegramUserId: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('📊 [getPositionsTool] Getting positions', context);

    try {
      const accounts = await db.query.mexcAccounts.findMany({
        where: and(
          eq(mexcAccounts.telegramUserId, context.telegramUserId),
          eq(mexcAccounts.isActive, true)
        ),
      });

      if (accounts.length === 0) {
        return { success: false, message: "❌ Нет активных аккаунтов" };
      }

      const results: string[] = [];
      results.push("📊 *Открытые позиции:*\n");

      for (const account of accounts) {
        try {
          const client = createMexcClient(account.uId);
          const posResponse = await client.getOpenPositions("");
          const positions = Array.isArray(posResponse) ? posResponse : [];

          if (positions.length === 0) {
            results.push(`👤 Аккаунт ${account.accountNumber}: нет открытых позиций\n`);
            continue;
          }

          results.push(`👤 *Аккаунт ${account.accountNumber}:*`);
          for (const pos of positions) {
            const sideText = (pos as any).side === 1 ? "LONG" : "SHORT";
            results.push(`🔹 ${(pos as any).symbol}: ${sideText} ${(pos as any).holdVol} | PnL: ${(pos as any).pnl > 0 ? "🟢" : "🔴"} ${(pos as any).pnl}`);
          }
        } catch (error: any) {
          results.push(`❌ Аккаунт ${account.accountNumber}: ${error.message}`);
        }
      }

      return { success: true, message: results.join("\n") };
    } catch (error: any) {
      return { success: false, message: `Ошибка: ${error.message}` };
    }
  },
});

/**
 * Tool: Get Balance
 */
export const getBalanceTool = createTool({
  id: "get-balance",
  description: "Get account balance and details",
  inputSchema: z.object({
    telegramUserId: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('💰 [getBalanceTool] Getting balance', context);

    try {
      const accounts = await db.query.mexcAccounts.findMany({
        where: and(
          eq(mexcAccounts.telegramUserId, context.telegramUserId),
          eq(mexcAccounts.isActive, true)
        ),
      });

      if (accounts.length === 0) {
        return { success: false, message: "❌ Нет активных аккаунтов" };
      }

      const results: string[] = [];
      results.push("💰 *Твои аккаунты и баланс:*\n");

      for (const account of accounts) {
        try {
          const client = createMexcClient(account.uId);
          const asset = await client.getAccountAsset("USDT");
          
          logger?.info(`📋 Raw asset response for account ${account.accountNumber}:`, JSON.stringify(asset, null, 2));
          
          // Extract balance from various possible structures
          let balance = 0;
          
          if (asset && typeof asset === 'object') {
            // Try different possible paths
            if ((asset as any).data?.availableBalance !== undefined) {
              balance = (asset as any).data.availableBalance;
            } else if ((asset as any).data?.balance !== undefined) {
              balance = (asset as any).data.balance;
            } else if ((asset as any).availableBalance !== undefined) {
              balance = (asset as any).availableBalance;
            } else if ((asset as any).balance !== undefined) {
              balance = (asset as any).balance;
            } else if ((asset as any).frozen !== undefined) {
              // Some APIs return frozen + available separately
              balance = ((asset as any).available || 0) + ((asset as any).frozen || 0);
            }
          }
          
          logger?.info(`💵 Extracted balance for account ${account.accountNumber}`, { balance });

          results.push(
            `✅ *Аккаунт ${account.accountNumber}*\n` +
            `   Баланс: ${balance.toFixed(2)} USDT\n` +
            `   Плечо: ${account.defaultLeverage}x | Размер: ${account.defaultSize}`
          );
        } catch (error: any) {
          logger?.error(`❌ Error getting balance for account ${account.accountNumber}`, { error: error.message });
          results.push(`❌ Аккаунт ${account.accountNumber}: ${error.message}`);
        }
      }

      return { success: true, message: results.join("\n") };
    } catch (error: any) {
      return { success: false, message: `Ошибка: ${error.message}` };
    }
  },
});

/**
 * Tool: Get Orders
 */
export const getOrdersTool = createTool({
  id: "get-orders",
  description: "Get open orders",
  inputSchema: z.object({
    telegramUserId: z.string(),
    symbol: z.string().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('📝 [getOrdersTool] Getting orders', context);

    try {
      const accounts = await db.query.mexcAccounts.findMany({
        where: and(
          eq(mexcAccounts.telegramUserId, context.telegramUserId),
          eq(mexcAccounts.isActive, true)
        ),
      });

      if (accounts.length === 0) {
        return { success: false, message: "❌ Нет активных аккаунтов" };
      }

      const results: string[] = [];
      results.push("📝 *Открытые ордера:*\n");

      for (const account of accounts) {
        try {
          const client = createMexcClient(account.uId);
          const symbol = context.symbol ? `${context.symbol}_USDT` : undefined;
          const orders = await client.getOpenOrders({ symbol } as any);

          if (!orders || Object.keys(orders).length === 0) {
            results.push(`👤 Аккаунт ${account.accountNumber}: нет открытых ордеров\n`);
            continue;
          }

          results.push(`👤 *Аккаунт ${account.accountNumber}:*`);
          for (const [key, orderList] of Object.entries(orders)) {
            if (Array.isArray(orderList)) {
              for (const order of orderList) {
                results.push(`🔹 ${(order as any).symbol}: ${(order as any).side} ${(order as any).vol} @ ${(order as any).price}`);
              }
            }
          }
        } catch (error: any) {
          results.push(`❌ Аккаунт ${account.accountNumber}: ${error.message}`);
        }
      }

      return { success: true, message: results.join("\n") };
    } catch (error: any) {
      return { success: false, message: `Ошибка: ${error.message}` };
    }
  },
});

/**
 * Tool: Cancel Orders
 */
export const cancelOrdersTool = createTool({
  id: "cancel-orders",
  description: "Cancel open orders for a symbol",
  inputSchema: z.object({
    telegramUserId: z.string(),
    symbol: z.string(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('❌ [cancelOrdersTool] Cancelling orders', context);

    try {
      const accounts = await db.query.mexcAccounts.findMany({
        where: and(
          eq(mexcAccounts.telegramUserId, context.telegramUserId),
          eq(mexcAccounts.isActive, true)
        ),
      });

      if (accounts.length === 0) {
        return { success: false, message: "❌ Нет активных аккаунтов" };
      }

      const symbol = `${context.symbol}_USDT`;
      const results: string[] = [];

      for (const account of accounts) {
        try {
          const client = createMexcClient(account.uId);
          await client.cancelOrder({ symbol } as any);
          results.push(`✅ Аккаунт ${account.accountNumber}: ордера отменены`);
        } catch (error: any) {
          results.push(`❌ Аккаунт ${account.accountNumber}: ${error.message}`);
        }
      }

      return { success: results.some(r => r.includes("✅")), message: results.join("\n") };
    } catch (error: any) {
      return { success: false, message: `Ошибка: ${error.message}` };
    }
  },
});

/**
 * Tool: Close SHORT Position at Specific Price (Limit Order)
 */
export const closeShortAtPriceTool = createTool({
  id: "close-short-at-price",
  description: "Closes a SHORT position at a specific price using limit order",
  inputSchema: z.object({
    telegramUserId: z.string(),
    symbol: z.string(),
    price: z.number(),
    size: z.number().optional(),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🔴 [closeShortAtPriceTool] Closing SHORT at price', context);

    try {
      const accounts = await db.query.mexcAccounts.findMany({
        where: and(
          eq(mexcAccounts.telegramUserId, context.telegramUserId),
          eq(mexcAccounts.isActive, true)
        ),
      });

      if (accounts.length === 0) {
        return { success: false, message: "❌ Нет активных аккаунтов" };
      }

      const symbol = `${context.symbol}_USDT`;
      const results: string[] = [];

      for (const account of accounts) {
        try {
          const client = createMexcClient(account.uId);
          // Get all positions
          const posResponse = await client.getOpenPositions("");
          
          logger?.info(`📍 Position response for account ${account.accountNumber}:`, posResponse);
          
          // Extract data array from response object
          let allPositions: any[] = [];
          if (posResponse && typeof posResponse === 'object' && Array.isArray(posResponse.data)) {
            allPositions = posResponse.data;
          } else if (Array.isArray(posResponse)) {
            allPositions = posResponse;
          }
          
          logger?.info(`📋 All positions for account ${account.accountNumber}:`, allPositions.map((p: any) => ({ symbol: p.symbol, positionType: p.positionType, holdVol: p.holdVol })));
          
          // Filter for SHORT positions of our symbol (positionType: 2 = SHORT)
          const positions = allPositions.filter((pos: any) => pos.symbol === symbol && pos.positionType === 2);
          
          logger?.info(`🔍 Filtered SHORT positions for ${symbol} (positionType=2):`, positions.map((p: any) => ({ symbol: p.symbol, positionType: p.positionType, holdVol: p.holdVol })));
          
          if (positions.length === 0) {
            results.push(`⚠️ Аккаунт ${account.accountNumber}: нет SHORT позиций по ${symbol}`);
            continue;
          }

          for (const pos of positions) {
            const closeSize = context.size || Math.abs((pos as any).holdVol);
            // To close SHORT position we SELL (side 2) at best bid price (limit order)
            const closeSide: 1 | 2 | 3 | 4 = 2; // Side 2 = SELL to close SHORT

            logger?.info(`📍 Closing SHORT at best bid price (limit)`, { symbol, price: context.price, size: closeSize });
            logger?.info(`🎯 ТОЧНАЯ ЦЕНА ДЛЯ MEXC API: ${context.price} (тип: ${typeof context.price})`);

            try {
              const orderType: 1 | 2 | 3 | 4 | 5 | 6 = 1; // Limit order
              const orderOpenType: 1 | 2 = 2;
              const orderParams = {
                symbol,
                side: closeSide,
                vol: closeSize,
                type: orderType, // Limit order at best bid price
                price: context.price,
                openType: orderOpenType,
              };
              logger?.info(`📤 Отправляю лимит-ордер по best bid:`, orderParams);
              
              await client.submitOrder(orderParams);
              results.push(`✅ Аккаунт ${account.accountNumber}: SHORT закрыта лимиткой по ${context.price}, ${closeSize} контрактов`);
            } catch (submitError: any) {
              logger?.error(`❌ Submit order error`, { error: submitError });
              throw submitError;
            }
          }
        } catch (error: any) {
          const errorMsg = error?.message || JSON.stringify(error) || "Unknown error";
          logger?.error(`❌ Error closing SHORT for account ${account.accountNumber}`, { error: errorMsg });
          results.push(`❌ Аккаунт ${account.accountNumber}: ${errorMsg}`);
        }
      }

      return { success: results.some(r => r.includes("✅")), message: results.join("\n") };
    } catch (error: any) {
      return { success: false, message: `Ошибка: ${error.message}` };
    }
  },
});
