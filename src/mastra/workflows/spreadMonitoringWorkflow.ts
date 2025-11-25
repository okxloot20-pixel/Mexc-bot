import { db } from "../storage/db";
import { autoCommands } from "../storage/schema";
import { eq } from "drizzle-orm";
import { checkAndExecuteSpreadTrades } from "../services/spreadMonitoringService";
import { parseAndExecuteCommand } from "../agents/mexcTradingAgent";

const MONITORING_INTERVAL = 15000; // 15 seconds

let isMonitoring = false;
let monitoringHandle: NodeJS.Timeout | null = null;

/**
 * Start the background spread monitoring
 */
export async function startSpreadMonitoring(mastra: any) {
  const logger = mastra?.logger || console;
  
  if (isMonitoring) {
    logger?.info("🔄 [SPREAD] Monitoring already running");
    return;
  }
  
  isMonitoring = true;
  logger?.info("🔄 [SPREAD] Starting background monitoring...");
  
  async function monitoringLoop() {
    try {
      // Get all users with spread monitoring enabled
      let users: any[] = [];
      try {
        if (db) {
          users = await db.query.autoCommands.findMany({
            where: eq(autoCommands.spreadMonitoringEnabled, true) as any,
          });
        }
      } catch (dbError) {
        logger?.error("❌ [SPREAD] Database error fetching users:", dbError);
        // Reschedule next iteration even if DB fails
        if (isMonitoring) {
          monitoringHandle = setTimeout(monitoringLoop, MONITORING_INTERVAL);
        }
        return;
      }
      
      for (const userAutoCmd of users) {
        const userId = userAutoCmd.telegramUserId;
        
        try {
          // Create fetcher functions that would use the trading agent's methods
          const mexcPriceFetcher = async (symbol: string): Promise<number | null> => {
            try {
              // Parse the /lb command to get price
              const result = await parseAndExecuteCommand(`/lb ${symbol}`, userId, mastra);
              // Extract price from response (would need parsing logic)
              // For now, placeholder
              return null;
            } catch (e) {
              return null;
            }
          };
          
          const positionsFetcher = async (userId: string) => {
            try {
              const result = await parseAndExecuteCommand("/positions", userId, mastra);
              // Parse positions from result
              return [];
            } catch (e) {
              return [];
            }
          };
          
          const ordersFetcher = async (userId: string) => {
            try {
              const result = await parseAndExecuteCommand("/orders", userId, mastra);
              // Parse orders from result
              return [];
            } catch (e) {
              return [];
            }
          };
          
          const openShortCallback = async (symbol: string) => {
            return parseAndExecuteCommand(`/sm ${symbol}`, userId, mastra);
          };
          
          const closeShortCallback = async (symbol: string) => {
            return parseAndExecuteCommand(`/closebs ${symbol}`, userId, mastra);
          };
          
          const telegramSender = async (userId: string, message: string) => {
            // Send to Telegram via API
            // Would need Telegram bot token to send directly
            logger?.info(`📱 [SPREAD TELEGRAM] ${userId}: ${message}`);
          };
          
          // Run spread monitoring for this user
          await checkAndExecuteSpreadTrades(
            userId,
            mexcPriceFetcher,
            positionsFetcher,
            ordersFetcher,
            openShortCallback,
            closeShortCallback,
            telegramSender,
            logger
          );
          
        } catch (error) {
          logger?.error(`❌ [SPREAD] Error monitoring user ${userId}:`, error);
        }
      }
      
    } catch (error) {
      logger?.error("❌ [SPREAD] Error in monitoring loop:", error);
    }
    
    // Schedule next iteration
    if (isMonitoring) {
      monitoringHandle = setTimeout(monitoringLoop, MONITORING_INTERVAL);
    }
  }
  
  // Start the loop
  monitoringHandle = setTimeout(monitoringLoop, MONITORING_INTERVAL);
}

/**
 * Stop the background spread monitoring
 */
export function stopSpreadMonitoring(mastra: any) {
  const logger = mastra?.logger || console;
  
  if (!isMonitoring) {
    logger?.info("🔄 [SPREAD] Monitoring not running");
    return;
  }
  
  if (monitoringHandle) {
    clearTimeout(monitoringHandle);
    monitoringHandle = null;
  }
  
  isMonitoring = false;
  logger?.info("✅ [SPREAD] Monitoring stopped");
}
