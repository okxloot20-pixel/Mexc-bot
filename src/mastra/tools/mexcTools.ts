import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { MexcFuturesClient } from "@max89701/mexc-futures-sdk";
import { db } from "../storage/db";
import { mexcAccounts } from "../storage/schema";
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

// Helper: Get contract multiplier from MEXC API
// Each symbol has different multiplier (BTC=100, ETH=10, ARTX=0.01, etc)
async function getContractMultiplier(symbol: string, logger?: any): Promise<number> {
  try {
    // Try to get from MEXC public API
    const response = await fetch(`https://contract.mexc.com/api/v1/contract/symbols`);
    const data = await response.json();
    
    if (data.success && data.data && Array.isArray(data.data)) {
      const symbolInfo = data.data.find((s: any) => s.symbol === symbol);
      if (symbolInfo) {
        const multiplier = parseFloat(symbolInfo.multiplier || symbolInfo.contractValue || 1);
        logger?.info(`📊 Symbol ${symbol} multiplier: ${multiplier}`);
        return multiplier;
      }
    }
    
    logger?.warn(`⚠️ Could not find multiplier for ${symbol}, using default 1`);
    return 1;
  } catch (error: any) {
    logger?.error('❌ Error fetching contract multiplier', { error: error.message });
    return 1; // Fallback to 1
  }
}

// Helper: Calculate max position size based on balance and leverage
async function getMaxPositionSize(client: MexcFuturesClient, symbol: string, leverage: number, logger?: any): Promise<number> {
  try {
    const asset = await client.getAccountAsset("USDT");
    const availableBalance = (asset as any).availableBalance || (asset as any).balance || 0;
    
    // Get the contract multiplier for this specific symbol
    const multiplier = await getContractMultiplier(symbol, logger);
    
    // Max size = (balance * leverage) / multiplier
    // Example: balance=100 USDT, leverage=20x, ARTX multiplier=0.01
    // maxSize = (100 * 20) / 0.01 = 200,000 contracts
    const maxSize = Math.floor((availableBalance * leverage) / multiplier);
    logger?.info(`💰 Max position size: ${maxSize} contracts (balance: ${availableBalance} USDT, leverage: ${leverage}x, multiplier: ${multiplier} USDT/contract)`);
    return Math.max(maxSize, 1); // At least 1 contract
  } catch (error: any) {
    logger?.error('❌ Error calculating max size', { error: error.message });
    return 10; // Fallback to 10 if error
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
          
          // Get max size based on balance
          let tradeSize = context.size;
          if (!tradeSize) {
            tradeSize = await getMaxPositionSize(client, symbol, tradeLeverage, logger);
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
          
          // Get max size based on balance
          let tradeSize = context.size;
          if (!tradeSize) {
            tradeSize = await getMaxPositionSize(client, symbol, tradeLeverage, logger);
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
          await client.submitOrder({
            symbol,
            side: 1,
            vol: context.size || account.defaultSize || 10,
            type: 1,
            price: context.price,
            leverage: context.leverage || account.defaultLeverage || 20,
            openType: 2,
          });
          results.push(`✅ Аккаунт ${account.accountNumber}: LONG лимит ${context.price}`);
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
          await client.submitOrder({
            symbol,
            side: 3,
            vol: context.size || account.defaultSize || 10,
            type: 1,
            price: context.price,
            leverage: context.leverage || account.defaultLeverage || 20,
            openType: 2,
          });
          results.push(`✅ Аккаунт ${account.accountNumber}: SHORT лимит ${context.price}`);
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
          const posResponse = await client.getOpenPositions(symbol);
          const positions = Array.isArray(posResponse) ? posResponse : [];

          if (positions.length === 0) {
            results.push(`⚠️ Аккаунт ${account.accountNumber}: нет открытых позиций`);
            continue;
          }

          for (const pos of positions) {
            const closeSize = context.size || Math.abs((pos as any).holdVol);
            const closeSide = (pos as any).side === 1 ? 4 : 2;

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
          const balance = (asset as any).availableBalance || (asset as any).balance || 0;

          results.push(
            `✅ *Аккаунт ${account.accountNumber}*\n` +
            `   Баланс: ${balance.toFixed(2)} USDT\n` +
            `   Плечо: ${account.defaultLeverage}x | Размер: ${account.defaultSize}`
          );
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
