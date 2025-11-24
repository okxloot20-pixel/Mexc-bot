import { db } from "../storage/db";
import { autoCommands, spreadMonitoringState } from "../storage/schema";
import { eq, and } from "drizzle-orm";

const ENTRY_SPREAD = 13; // Entry threshold: 13%
const RESET_SPREAD = 7;  // Reset threshold: 7%
const EXIT_SPREAD = 2;   // Exit threshold: 2%

interface AutoCommand {
  symbol: string;
  dexPairId?: string;
}

/**
 * Get cached DEX price from DexScreener
 */
async function getDexPrice(dexPairId: string): Promise<number | null> {
  try {
    const response = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${dexPairId}`);
    const data = await response.json();
    
    if (data?.pairs && data.pairs[0]?.priceUsd) {
      return parseFloat(data.pairs[0].priceUsd);
    }
    return null;
  } catch (error) {
    console.error("Error fetching DEX price:", error);
    return null;
  }
}

/**
 * Calculate spread percentage
 */
function calculateSpread(mexcPrice: number, dexPrice: number): number {
  return Math.abs(mexcPrice - dexPrice) / dexPrice * 100;
}

/**
 * Check if symbol has open position or pending order
 */
async function hasOpenPositionOrOrder(
  userId: string,
  symbol: string,
  fetchPositions: (userId: string) => Promise<any[]>,
  fetchOrders: (userId: string) => Promise<any[]>
): Promise<boolean> {
  try {
    const positions = await fetchPositions(userId);
    const orders = await fetchOrders(userId);
    
    // Check for open SHORT position
    const hasOpenShort = positions.some(p => 
      p.symbol === symbol && p.direction === "SHORT" && p.quantity > 0
    );
    
    // Check for open orders on this symbol (any pending order created by spread module)
    const hasOpenOrder = orders.some(o => o.symbol === symbol);
    
    return hasOpenShort || hasOpenOrder;
  } catch (error) {
    console.error("Error checking open position/order:", error);
    return true; // Default to true (don't trade) if we can't check
  }
}

/**
 * Get or create hysteresis state for symbol
 */
async function getOrCreateState(
  userId: string,
  symbol: string
): Promise<any> {
  let state = await db.query.spreadMonitoringState.findFirst({
    where: and(
      eq(spreadMonitoringState.telegramUserId, userId),
      eq(spreadMonitoringState.symbol, symbol)
    ),
  });
  
  if (!state) {
    await db.insert(spreadMonitoringState).values({
      telegramUserId: userId,
      symbol,
      wasTriggered: false,
    });
    
    state = await db.query.spreadMonitoringState.findFirst({
      where: and(
        eq(spreadMonitoringState.telegramUserId, userId),
        eq(spreadMonitoringState.symbol, symbol)
      ),
    });
  }
  
  return state;
}

/**
 * Update hysteresis state
 */
async function updateState(
  userId: string,
  symbol: string,
  wasTriggered: boolean,
  mexcPrice?: number,
  dexPrice?: number,
  spreadPercent?: number
): Promise<void> {
  await db.update(spreadMonitoringState)
    .set({
      wasTriggered,
      lastMexcPrice: mexcPrice?.toString(),
      lastDexPrice: dexPrice?.toString(),
      lastSpreadPercent: spreadPercent?.toString(),
      lastActionAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(
      eq(spreadMonitoringState.telegramUserId, userId),
      eq(spreadMonitoringState.symbol, symbol)
    ));
}

/**
 * Main spread monitoring logic
 */
export async function checkAndExecuteSpreadTrades(
  userId: string,
  mexcPriceFetcher: (symbol: string) => Promise<number | null>,
  positionsFetcher: (userId: string) => Promise<any[]>,
  ordersFetcher: (userId: string) => Promise<any[]>,
  openShortCallback: (symbol: string) => Promise<string>,
  closeShortCallback: (symbol: string) => Promise<string>,
  telegramSender: (userId: string, message: string) => Promise<void>,
  logger: any
): Promise<void> {
  try {
    // Get user's auto commands
    const autoCmd = await db.query.autoCommands.findFirst({
      where: eq(autoCommands.telegramUserId, userId),
    });
    
    if (!autoCmd || !autoCmd.spreadMonitoringEnabled) {
      return;
    }
    
    const commands: AutoCommand[] = JSON.parse(autoCmd.commands || "[]");
    
    for (const cmd of commands) {
      const { symbol, dexPairId } = cmd;
      
      // Skip if no DEX pair configured
      if (!dexPairId) {
        continue;
      }
      
      try {
        // Get prices
        const mexcPrice = await mexcPriceFetcher(symbol);
        const dexPrice = await getDexPrice(dexPairId);
        
        if (!mexcPrice || !dexPrice) {
          logger?.debug(`❌ [SPREAD] Could not fetch prices for ${symbol}`);
          continue;
        }
        
        const spreadPercent = calculateSpread(mexcPrice, dexPrice);
        const isPositiveSpreading = mexcPrice > dexPrice; // MEXC > DEX means SHORT opportunity
        
        logger?.info(`📊 [SPREAD] ${symbol}: MEXC=${mexcPrice}, DEX=${dexPrice}, Spread=${spreadPercent.toFixed(2)}%, Positive=${isPositiveSpreading}`);
        
        // Get current state
        const state = await getOrCreateState(userId, symbol);
        
        // ENTRY LOGIC: spreadPercent >= 13% && mexcPrice > dexPrice && !wasTriggered
        if (
          spreadPercent >= ENTRY_SPREAD &&
          isPositiveSpreading &&
          !state.wasTriggered
        ) {
          // Check if already has open position
          const hasOpen = await hasOpenPositionOrOrder(userId, symbol, positionsFetcher, ordersFetcher);
          
          if (!hasOpen) {
            logger?.info(`🔻 [SPREAD] Opening SHORT for ${symbol} at spread=${spreadPercent.toFixed(2)}%`);
            
            // Open SHORT market order
            await openShortCallback(symbol);
            
            // Mark as triggered (now waiting for spread to drop < 7%)
            await updateState(userId, symbol, true, mexcPrice, dexPrice, spreadPercent);
            
            // Send Telegram notification
            await telegramSender(userId, `🔻 *Авто-SHORT по спреду*\n\n📍 Монета: ${symbol}\n💵 Цена MEXC: ${mexcPrice.toFixed(8)}\n💵 Цена DEX: ${dexPrice.toFixed(8)}\n📊 Спред: ${spreadPercent.toFixed(2)}%`);
          }
        }
        
        // RESET LOGIC: spreadPercent < 7% => reset triggered state
        if (state.wasTriggered && spreadPercent < RESET_SPREAD) {
          logger?.info(`🔄 [SPREAD] Resetting state for ${symbol} (spread < ${RESET_SPREAD}%)`);
          await updateState(userId, symbol, false, mexcPrice, dexPrice, spreadPercent);
        }
        
        // EXIT LOGIC: has SHORT position && spreadPercent < 2%
        if (state.wasTriggered && spreadPercent < EXIT_SPREAD) {
          const positions = await positionsFetcher(userId);
          const hasShortPosition = positions.some(p => 
            p.symbol === symbol && p.direction === "SHORT" && p.quantity > 0
          );
          
          if (hasShortPosition) {
            logger?.info(`✅ [SPREAD] Closing SHORT for ${symbol} at spread=${spreadPercent.toFixed(2)}%`);
            
            // Close SHORT via /closebs
            await closeShortCallback(symbol);
            
            // Send Telegram notification
            await telegramSender(userId, `✅ *Авто-закрытие SHORT по спреду*\n\n📍 Монета: ${symbol}\n📊 Спред: ${spreadPercent.toFixed(2)}% (< 2%)\n✅ Вызвана команда /closebs ${symbol}`);
          }
        }
        
      } catch (error) {
        logger?.error(`❌ [SPREAD] Error processing ${symbol}:`, error);
      }
    }
    
  } catch (error) {
    logger?.error("❌ [SPREAD] Error in checkAndExecuteSpreadTrades:", error);
  }
}
