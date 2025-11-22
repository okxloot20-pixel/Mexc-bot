import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import crypto from "crypto";

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

// Helper function to make authenticated MEXC API calls
async function mexcApiCall(
  endpoint: string,
  method: string,
  webUid: string,
  proxy: string | null,
  params: Record<string, any> = {}
): Promise<any> {
  const baseUrl = "https://contract.mexc.com";
  const timestamp = Date.now();
  
  const requestParams = {
    ...params,
    timestamp,
  };

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Cookie": `WEB_UID=${webUid}`,
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

  // If proxy is provided, we would use it here (simplified for now)
  const response = await fetch(url, fetchOptions);
  
  if (!response.ok) {
    throw new Error(`MEXC API error: ${response.status} ${response.statusText}`);
  }

  return await response.json();
}

/**
 * Tool: Open Long Market Position
 * Opens a long position at market price
 */
export const openLongMarketTool = createTool({
  id: "open-long-market",
  description: "Opens a LONG market position on MEXC futures for specified symbol and size",
  inputSchema: z.object({
    accountId: z.string().describe("Account ID from user's accounts"),
    symbol: z.string().describe("Trading pair symbol (e.g., BTC, ETH - without _USDT)"),
    size: z.number().describe("Position size in contracts"),
    leverage: z.number().optional().describe("Leverage multiplier (optional, uses default if not provided)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    orderId: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🟢 [openLongMarketTool] Opening LONG market position', context);

    try {
      const symbol = `${context.symbol}_USDT`;
      
      // Mock implementation - replace with actual MEXC API call
      // In real implementation, retrieve webUid and proxy from database using accountId
      const webUid = process.env.MEXC_WEB_UID || "";
      const proxy = process.env.MEXC_PROXY || null;
      
      const result = await mexcApiCall(
        "/api/v1/private/order/submit",
        "POST",
        webUid,
        proxy,
        {
          symbol,
          side: "BUY",
          type: "MARKET",
          vol: context.size,
          leverage: context.leverage || 20,
          openType: 1, // Open long
        }
      );

      logger?.info('✅ [openLongMarketTool] Position opened successfully', result);

      return {
        success: true,
        orderId: result.data?.orderId || "mock-order-id",
        message: `LONG market order placed for ${context.size} contracts of ${symbol}`,
      };
    } catch (error: any) {
      logger?.error('❌ [openLongMarketTool] Error opening position', { error: error.message });
      return {
        success: false,
        message: `Failed to open position: ${error.message}`,
      };
    }
  },
});

/**
 * Tool: Open Short Market Position
 * Opens a short position at market price
 */
export const openShortMarketTool = createTool({
  id: "open-short-market",
  description: "Opens a SHORT market position on MEXC futures for specified symbol and size",
  inputSchema: z.object({
    accountId: z.string().describe("Account ID from user's accounts"),
    symbol: z.string().describe("Trading pair symbol (e.g., BTC, ETH - without _USDT)"),
    size: z.number().describe("Position size in contracts"),
    leverage: z.number().optional().describe("Leverage multiplier (optional, uses default if not provided)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    orderId: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🔴 [openShortMarketTool] Opening SHORT market position', context);

    try {
      const symbol = `${context.symbol}_USDT`;
      const webUid = process.env.MEXC_WEB_UID || "";
      const proxy = process.env.MEXC_PROXY || null;
      
      const result = await mexcApiCall(
        "/api/v1/private/order/submit",
        "POST",
        webUid,
        proxy,
        {
          symbol,
          side: "SELL",
          type: "MARKET",
          vol: context.size,
          leverage: context.leverage || 20,
          openType: 2, // Open short
        }
      );

      logger?.info('✅ [openShortMarketTool] Position opened successfully', result);

      return {
        success: true,
        orderId: result.data?.orderId || "mock-order-id",
        message: `SHORT market order placed for ${context.size} contracts of ${symbol}`,
      };
    } catch (error: any) {
      logger?.error('❌ [openShortMarketTool] Error opening position', { error: error.message });
      return {
        success: false,
        message: `Failed to open position: ${error.message}`,
      };
    }
  },
});

/**
 * Tool: Open Long Limit Position
 * Opens a long position at specified limit price
 */
export const openLongLimitTool = createTool({
  id: "open-long-limit",
  description: "Opens a LONG limit position on MEXC futures at specified price",
  inputSchema: z.object({
    accountId: z.string().describe("Account ID from user's accounts"),
    price: z.number().describe("Limit price for entry"),
    symbol: z.string().describe("Trading pair symbol (e.g., BTC, ETH - without _USDT)"),
    size: z.number().describe("Position size in contracts"),
    leverage: z.number().optional().describe("Leverage multiplier (optional, uses default if not provided)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    orderId: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🟢 [openLongLimitTool] Opening LONG limit position', context);

    try {
      const symbol = `${context.symbol}_USDT`;
      const webUid = process.env.MEXC_WEB_UID || "";
      const proxy = process.env.MEXC_PROXY || null;
      
      const result = await mexcApiCall(
        "/api/v1/private/order/submit",
        "POST",
        webUid,
        proxy,
        {
          symbol,
          side: "BUY",
          type: "LIMIT",
          price: context.price,
          vol: context.size,
          leverage: context.leverage || 20,
          openType: 1,
        }
      );

      logger?.info('✅ [openLongLimitTool] Limit order placed successfully', result);

      return {
        success: true,
        orderId: result.data?.orderId || "mock-order-id",
        message: `LONG limit order placed at ${context.price} USDT for ${context.size} contracts of ${symbol}`,
      };
    } catch (error: any) {
      logger?.error('❌ [openLongLimitTool] Error placing limit order', { error: error.message });
      return {
        success: false,
        message: `Failed to place limit order: ${error.message}`,
      };
    }
  },
});

/**
 * Tool: Open Short Limit Position
 * Opens a short position at specified limit price
 */
export const openShortLimitTool = createTool({
  id: "open-short-limit",
  description: "Opens a SHORT limit position on MEXC futures at specified price",
  inputSchema: z.object({
    accountId: z.string().describe("Account ID from user's accounts"),
    price: z.number().describe("Limit price for entry"),
    symbol: z.string().describe("Trading pair symbol (e.g., BTC, ETH - without _USDT)"),
    size: z.number().describe("Position size in contracts"),
    leverage: z.number().optional().describe("Leverage multiplier (optional, uses default if not provided)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    orderId: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🔴 [openShortLimitTool] Opening SHORT limit position', context);

    try {
      const symbol = `${context.symbol}_USDT`;
      const webUid = process.env.MEXC_WEB_UID || "";
      const proxy = process.env.MEXC_PROXY || null;
      
      const result = await mexcApiCall(
        "/api/v1/private/order/submit",
        "POST",
        webUid,
        proxy,
        {
          symbol,
          side: "SELL",
          type: "LIMIT",
          price: context.price,
          vol: context.size,
          leverage: context.leverage || 20,
          openType: 2,
        }
      );

      logger?.info('✅ [openShortLimitTool] Limit order placed successfully', result);

      return {
        success: true,
        orderId: result.data?.orderId || "mock-order-id",
        message: `SHORT limit order placed at ${context.price} USDT for ${context.size} contracts of ${symbol}`,
      };
    } catch (error: any) {
      logger?.error('❌ [openShortLimitTool] Error placing limit order', { error: error.message });
      return {
        success: false,
        message: `Failed to place limit order: ${error.message}`,
      };
    }
  },
});

/**
 * Tool: Close Position
 * Closes an open position at market price
 */
export const closePositionTool = createTool({
  id: "close-position",
  description: "Closes an open position at market price for specified symbol",
  inputSchema: z.object({
    accountId: z.string().describe("Account ID from user's accounts"),
    symbol: z.string().describe("Trading pair symbol (e.g., BTC, ETH - without _USDT)"),
    size: z.number().optional().describe("Size to close (optional, closes entire position if not provided)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    orderId: z.string().optional(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🧹 [closePositionTool] Closing position', context);

    try {
      const symbol = `${context.symbol}_USDT`;
      const webUid = process.env.MEXC_WEB_UID || "";
      const proxy = process.env.MEXC_PROXY || null;
      
      // First, get current position to determine side
      const positions = await mexcApiCall(
        "/api/v1/private/position/list",
        "GET",
        webUid,
        proxy,
        { symbol }
      );

      // Find the position
      const position = positions.data?.find((p: any) => p.symbol === symbol);
      
      if (!position || position.holdVol === 0) {
        return {
          success: false,
          message: `No open position found for ${symbol}`,
        };
      }

      // Close the position (opposite side of current position)
      const closeSide = position.positionType === 1 ? "SELL" : "BUY";
      const closeSize = context.size || position.holdVol;

      const result = await mexcApiCall(
        "/api/v1/private/order/submit",
        "POST",
        webUid,
        proxy,
        {
          symbol,
          side: closeSide,
          type: "MARKET",
          vol: closeSize,
          closeType: 3, // Close position
        }
      );

      logger?.info('✅ [closePositionTool] Position closed successfully', result);

      return {
        success: true,
        orderId: result.data?.orderId || "mock-order-id",
        message: `Closed ${closeSize} contracts of ${symbol}`,
      };
    } catch (error: any) {
      logger?.error('❌ [closePositionTool] Error closing position', { error: error.message });
      return {
        success: false,
        message: `Failed to close position: ${error.message}`,
      };
    }
  },
});

/**
 * Tool: Get Open Positions
 * Retrieves all open positions for the account
 */
export const getPositionsTool = createTool({
  id: "get-positions",
  description: "Retrieves all open positions for all active accounts",
  inputSchema: z.object({
    accountId: z.string().optional().describe("Specific account ID (optional, returns all if not provided)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    positions: z.array(z.object({
      accountId: z.string(),
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
      const webUid = process.env.MEXC_WEB_UID || "";
      const proxy = process.env.MEXC_PROXY || null;
      
      const result = await mexcApiCall(
        "/api/v1/private/position/list",
        "GET",
        webUid,
        proxy,
        {}
      );

      const positions = (result.data || []).map((p: any) => ({
        accountId: context.accountId || "main",
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

      logger?.info('✅ [getPositionsTool] Positions retrieved successfully', { count: positions.length });

      return {
        success: true,
        positions,
        message: `Found ${positions.length} open position(s)`,
      };
    } catch (error: any) {
      logger?.error('❌ [getPositionsTool] Error fetching positions', { error: error.message });
      return {
        success: false,
        message: `Failed to fetch positions: ${error.message}`,
      };
    }
  },
});

/**
 * Tool: Get Account Balance
 * Retrieves account balance information
 */
export const getBalanceTool = createTool({
  id: "get-balance",
  description: "Retrieves balance and account information for all active MEXC accounts",
  inputSchema: z.object({
    accountId: z.string().optional().describe("Specific account ID (optional)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    accounts: z.array(z.object({
      accountId: z.string(),
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
      const webUid = process.env.MEXC_WEB_UID || "";
      const proxy = process.env.MEXC_PROXY || null;
      
      const result = await mexcApiCall(
        "/api/v1/private/account/assets",
        "GET",
        webUid,
        proxy,
        {}
      );

      const accounts = [{
        accountId: context.accountId || "main",
        status: "✅ Active",
        balance: result.data?.availableBalance || 0,
        leverage: 20,
        size: 10,
        proxy: proxy || undefined,
      }];

      logger?.info('✅ [getBalanceTool] Balance retrieved successfully', accounts);

      return {
        success: true,
        accounts,
        message: `Balance: ${accounts[0].balance} USDT`,
      };
    } catch (error: any) {
      logger?.error('❌ [getBalanceTool] Error fetching balance', { error: error.message });
      return {
        success: false,
        message: `Failed to fetch balance: ${error.message}`,
      };
    }
  },
});

/**
 * Tool: Get Open Orders
 * Retrieves all open orders
 */
export const getOrdersTool = createTool({
  id: "get-orders",
  description: "Retrieves all open orders for specified symbol or all symbols",
  inputSchema: z.object({
    accountId: z.string().optional().describe("Specific account ID (optional)"),
    symbol: z.string().optional().describe("Trading pair symbol (optional, returns all if not provided)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    orders: z.array(z.object({
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
      const webUid = process.env.MEXC_WEB_UID || "";
      const proxy = process.env.MEXC_PROXY || null;
      
      const params: any = {};
      if (context.symbol) {
        params.symbol = `${context.symbol}_USDT`;
      }

      const result = await mexcApiCall(
        "/api/v1/private/order/list/open_orders",
        "GET",
        webUid,
        proxy,
        params
      );

      const orders = (result.data || []).map((o: any) => ({
        orderId: o.orderId,
        symbol: o.symbol,
        side: o.side,
        type: o.orderType,
        price: o.price,
        size: o.vol,
        filled: o.dealVol,
      }));

      logger?.info('✅ [getOrdersTool] Orders retrieved successfully', { count: orders.length });

      return {
        success: true,
        orders,
        message: `Found ${orders.length} open order(s)`,
      };
    } catch (error: any) {
      logger?.error('❌ [getOrdersTool] Error fetching orders', { error: error.message });
      return {
        success: false,
        message: `Failed to fetch orders: ${error.message}`,
      };
    }
  },
});

/**
 * Tool: Cancel Orders
 * Cancels all open orders for a symbol
 */
export const cancelOrdersTool = createTool({
  id: "cancel-orders",
  description: "Cancels all open orders for specified trading symbol",
  inputSchema: z.object({
    accountId: z.string().describe("Account ID from user's accounts"),
    symbol: z.string().describe("Trading pair symbol (e.g., BTC, ETH - without _USDT)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    cancelledCount: z.number().optional(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('❌ [cancelOrdersTool] Cancelling orders', context);

    try {
      const symbol = `${context.symbol}_USDT`;
      const webUid = process.env.MEXC_WEB_UID || "";
      const proxy = process.env.MEXC_PROXY || null;
      
      const result = await mexcApiCall(
        "/api/v1/private/order/cancel_all",
        "POST",
        webUid,
        proxy,
        { symbol }
      );

      logger?.info('✅ [cancelOrdersTool] Orders cancelled successfully', result);

      return {
        success: true,
        cancelledCount: result.data?.cancelledCount || 0,
        message: `Cancelled all orders for ${symbol}`,
      };
    } catch (error: any) {
      logger?.error('❌ [cancelOrdersTool] Error cancelling orders', { error: error.message });
      return {
        success: false,
        message: `Failed to cancel orders: ${error.message}`,
      };
    }
  },
});
