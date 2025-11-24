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
 * TEST FUNCTION: Simulate spread entry scenario
 */
export async function testSpreadEntry(
  userId: string,
  symbol: string,
  positionsFetcher: (userId: string) => Promise<any[]>,
  ordersFetcher: (userId: string) => Promise<any[]>,
  logger: any
): Promise<string> {
  try {
    // Get user's auto commands
    const autoCmd = await db.query.autoCommands.findFirst({
      where: eq(autoCommands.telegramUserId, userId),
    });
    
    if (!autoCmd) {
      return `❌ Нет сохранённых команд автотрейдинга`;
    }
    
    const commands: AutoCommand[] = JSON.parse(autoCmd.commands || "[]");
    const cmd = commands.find(c => c.symbol === symbol.toUpperCase());
    
    if (!cmd) {
      return `❌ Монета ${symbol} не найдена в /auto`;
    }
    
    // Simulate entry conditions
    const testMexcPrice = 100; // Mock price
    const testDexPrice = 86.9; // Creates 15% spread
    const testSpread = calculateSpread(testMexcPrice, testDexPrice);
    const isPositiveSpreading = testMexcPrice > testDexPrice;
    
    // Get state
    const state = await getOrCreateState(userId, symbol.toUpperCase());
    
    let result = `🔬 *DEBUG TEST: Spread Entry для ${symbol}*\n\n`;
    result += `📊 Тестовые цены:\n`;
    result += `• MEXC: ${testMexcPrice} USDT\n`;
    result += `• DEX: ${testDexPrice} USDT\n`;
    result += `• Спред: ${testSpread.toFixed(2)}%\n`;
    result += `• MEXC > DEX: ${isPositiveSpreading ? '✅ ДА' : '❌ НЕТ'}\n\n`;
    
    // Check decision logic
    result += `📋 *Анализ решения:*\n`;
    result += `• Спред >= 13%: ${testSpread >= ENTRY_SPREAD ? '✅ ДА' : '❌ НЕТ'}\n`;
    result += `• MEXC > DEX: ${isPositiveSpreading ? '✅ ДА' : '❌ НЕТ'}\n`;
    result += `• wasTriggered=false: ${!state.wasTriggered ? '✅ ДА' : '❌ НЕТ'}\n\n`;
    
    // Check open position
    const hasOpen = await hasOpenPositionOrOrder(userId, symbol.toUpperCase(), positionsFetcher, ordersFetcher);
    result += `• Нет открытой позиции: ${!hasOpen ? '✅ ДА' : '❌ НЕТ'}\n\n`;
    
    // Final decision
    const shouldEnter = (
      testSpread >= ENTRY_SPREAD &&
      isPositiveSpreading &&
      !state.wasTriggered &&
      !hasOpen
    );
    
    result += `⚡ *РЕШЕНИЕ:* ${shouldEnter ? '✅ ОТКРЫТЬ SHORT' : '❌ НЕ ОТКРЫВАТЬ'}\n`;
    
    if (shouldEnter) {
      result += `\n💡 В реальном цикле здесь была бы команда:\n\`/sm ${symbol}\`\n`;
      result += `📬 И отправлено уведомление в Telegram`;
    }
    
    logger?.info(`🔬 [SPREAD TEST ENTRY] ${symbol}: shouldEnter=${shouldEnter}, spread=${testSpread.toFixed(2)}%`);
    
    return result;
  } catch (error: any) {
    logger?.error("❌ [SPREAD TEST ENTRY] Error:", error);
    return `❌ Ошибка при тестировании: ${error.message}`;
  }
}

/**
 * TEST FUNCTION: Simulate spread exit scenario
 */
export async function testSpreadExit(
  userId: string,
  symbol: string,
  positionsFetcher: (userId: string) => Promise<any[]>,
  logger: any
): Promise<string> {
  try {
    // Get state
    const state = await getOrCreateState(userId, symbol.toUpperCase());
    
    // Simulate exit conditions
    const testMexcPrice = 100;
    const testDexPrice = 101.5; // Creates 1.5% spread
    const testSpread = calculateSpread(testMexcPrice, testDexPrice);
    
    // Check open position
    const positions = await positionsFetcher(userId);
    const hasShortPosition = positions.some(p => 
      p.symbol === symbol.toUpperCase() && p.direction === "SHORT" && p.quantity > 0
    );
    
    let result = `🔬 *DEBUG TEST: Spread Exit для ${symbol}*\n\n`;
    result += `📊 Тестовые цены:\n`;
    result += `• MEXC: ${testMexcPrice} USDT\n`;
    result += `• DEX: ${testDexPrice} USDT\n`;
    result += `• Спред: ${testSpread.toFixed(2)}%\n\n`;
    
    result += `📋 *Анализ решения:*\n`;
    result += `• wasTriggered=true: ${state.wasTriggered ? '✅ ДА' : '❌ НЕТ'}\n`;
    result += `• Спред < 2%: ${testSpread < EXIT_SPREAD ? '✅ ДА' : '❌ НЕТ'}\n`;
    result += `• Есть SHORT позиция: ${hasShortPosition ? '✅ ДА' : '❌ НЕТ'}\n\n`;
    
    // Final decision
    const shouldClose = (
      state.wasTriggered &&
      testSpread < EXIT_SPREAD &&
      hasShortPosition
    );
    
    result += `⚡ *РЕШЕНИЕ:* ${shouldClose ? '✅ ЗАКРЫТЬ SHORT' : '❌ НЕ ЗАКРЫВАТЬ'}\n`;
    
    if (shouldClose) {
      result += `\n💡 В реальном цикле здесь была бы команда:\n\`/closebs ${symbol}\`\n`;
      result += `📬 И отправлено уведомление в Telegram`;
    } else {
      if (!state.wasTriggered) {
        result += `\n⚠️ Причина: позиция не была открыта авто-модулем (wasTriggered=false)`;
      }
      if (testSpread >= EXIT_SPREAD) {
        result += `\n⚠️ Причина: спред еще >= 2% (${testSpread.toFixed(2)}%)`;
      }
      if (!hasShortPosition) {
        result += `\n⚠️ Причина: нет открытой SHORT позиции`;
      }
    }
    
    logger?.info(`🔬 [SPREAD TEST EXIT] ${symbol}: shouldClose=${shouldClose}, spread=${testSpread.toFixed(2)}%`);
    
    return result;
  } catch (error: any) {
    logger?.error("❌ [SPREAD TEST EXIT] Error:", error);
    return `❌ Ошибка при тестировании: ${error.message}`;
  }
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
        
        // Get current state for decision logging
        const state = await getOrCreateState(userId, symbol);
        
        // Determine decision
        let decision = "hold";
        if (spreadPercent >= ENTRY_SPREAD && isPositiveSpreading && !state.wasTriggered) {
          decision = "enter";
        } else if (state.wasTriggered && spreadPercent < RESET_SPREAD) {
          decision = "wait reset";
        } else if (state.wasTriggered && spreadPercent < EXIT_SPREAD) {
          decision = "close";
        } else if (state.wasTriggered) {
          decision = "hold";
        } else {
          decision = "skip";
        }
        
        // Check if this is an auto-position
        const positions = await positionsFetcher(userId);
        const isAutoPosition = positions.some(p => 
          p.symbol === symbol && p.direction === "SHORT" && p.quantity > 0
        ) && state.wasTriggered;
        
        logger?.info(`📊 [SPREAD] ${symbol}:
    mexcPrice=${mexcPrice.toFixed(8)}, dexPrice=${dexPrice.toFixed(8)}, spreadPercent=${spreadPercent.toFixed(2)}%
    decision="${decision}", autoPosition=${isAutoPosition}, wasTriggered=${state.wasTriggered}`);
        
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
