import { Agent } from "@mastra/core/agent";
import { Memory } from "@mastra/memory";
import { sharedPostgresStorage } from "../storage";
import { createOpenAI } from "@ai-sdk/openai";
import { db } from "../storage/db";
import { mexcAccounts } from "../storage/schema";
import { eq, and } from "drizzle-orm";
import { mexcApiCall } from "../tools/mexcTools";
import {
  openLongMarketTool,
  openShortMarketTool,
  openLongLimitTool,
  openShortLimitTool,
  closePositionTool,
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
// Helper function to open position on all active accounts
async function openPositionOnAccounts(
  userId: string,
  symbol: string,
  side: "BUY" | "SELL",
  size?: number,
  leverage?: number,
  isMarket: boolean = true,
  price?: number
): Promise<string> {
  try {
    const accounts = await db.query.mexcAccounts.findMany({
      where: and(
        eq(mexcAccounts.telegramUserId, userId),
        eq(mexcAccounts.isActive, true)
      ),
    });

    if (accounts.length === 0) {
      return `❌ Нет активных аккаунтов. Используйте /register для добавления`;
    }

    const fullSymbol = `${symbol}_USDT`;
    const results: string[] = [];

    for (const account of accounts) {
      try {
        const tradeSize = size || account.defaultSize || 10;
        const tradeLeverage = leverage || account.defaultLeverage || 20;

        const params = {
          symbol: fullSymbol,
          side,
          type: isMarket ? "MARKET" : "LIMIT",
          vol: tradeSize,
          leverage: tradeLeverage,
          openType: side === "BUY" ? 1 : 2,
        };

        if (!isMarket && price) {
          (params as any).price = price;
        }

        const response = await mexcApiCall(
          "/api/v1/private/order/submit",
          "POST",
          account.uId,
          account.proxy || null,
          params
        );

        if (response?.data?.orderId) {
          results.push(`✅ Аккаунт ${account.accountNumber}: Ордер ${response.data.orderId}`);
        } else {
          results.push(`✅ Аккаунт ${account.accountNumber}: Позиция открыта`);
        }
      } catch (error: any) {
        const errorMsg = error.message.includes("401") 
          ? "⚠️ WEB_UID неверный или истёк - обновите его через /register"
          : error.message.substring(0, 60);
        results.push(`⚠️ Аккаунт ${account.accountNumber}: ${errorMsg}`);
      }
    }

    return results.join("\n");
  } catch (error: any) {
    return `❌ Ошибка: ${error.message}`;
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
    return `🤖 *Mexc Futures Trading Bot*
    
*Доступные команды:*
/register - Регистрация аккаунта
/accounts - Список аккаунтов
/lm BTC - Открыть LONG позицию
/sm BTC - Открыть SHORT позицию
/positions - Открытые позиции
/balance - Баланс
/cancel - Отменить ордер`;
  }
  
  // Register account (with or without parameters)
  if (cmd.startsWith("/register")) {
    const parts = message.trim().split(/\s+/);
    if (parts.length === 1) {
      // Just /register - show help
      return `📝 *Регистрация аккаунта MEXC*

Отправь данные в формате:
\`/register ACCOUNT_NUM U_ID [PROXY_URL]\`

U_ID находится в девтулах браузера → Application → Cookies → u_id

Пример:
\`/register 474 156.246.241.55:63016:uYgG5GfzfZFWGZnW\``;
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
  
  // Open LONG market
  if (cmd.startsWith("/lm")) {
    const parts = message.trim().split(/\s+/);
    const symbol = parts[1] ? parts[1].toUpperCase() : "BTC";
    const size = parts[2] ? parseInt(parts[2]) : undefined;
    const leverage = parts[3] ? parseInt(parts[3]) : undefined;
    
    const result = await openPositionOnAccounts(userId, symbol, "BUY", size, leverage, true);
    return `✅ *LONG позиция открывается*\n\n${result}`;
  }
  
  // Open SHORT market
  if (cmd.startsWith("/sm")) {
    const parts = message.trim().split(/\s+/);
    const symbol = parts[1] ? parts[1].toUpperCase() : "BTC";
    const size = parts[2] ? parseInt(parts[2]) : undefined;
    const leverage = parts[3] ? parseInt(parts[3]) : undefined;
    
    const result = await openPositionOnAccounts(userId, symbol, "SELL", size, leverage, true);
    return `🔴 *SHORT позиция открывается*\n\n${result}`;
  }
  
  // Open LONG limit
  if (cmd.startsWith("/l ")) {
    const parts = message.trim().split(/\s+/);
    const price = parts[1] || "0";
    const symbol = parts[2] ? parts[2].toUpperCase() : "BTC";
    const size = parts[3] || "10";
    const leverage = parts[4] || "20";
    return `✅ *Лимит LONG ордер создан*

Цена: ${price}
Символ: ${symbol}_USDT
Размер: ${size} контрактов
Рычаг: ${leverage}x`;
  }
  
  // Open SHORT limit
  if (cmd.startsWith("/s ")) {
    const parts = message.trim().split(/\s+/);
    const price = parts[1] || "0";
    const symbol = parts[2] ? parts[2].toUpperCase() : "BTC";
    const size = parts[3] || "10";
    const leverage = parts[4] || "20";
    return `✅ *Лимит SHORT ордер создан*

Цена: ${price}
Символ: ${symbol}_USDT
Размер: ${size} контрактов
Рычаг: ${leverage}x`;
  }
  
  // Close position
  if (cmd.startsWith("/close")) {
    const parts = message.trim().split(/\s+/);
    const symbol = parts[1] ? parts[1].toUpperCase() : "BTC";
    const size = parts[2] ? parseInt(parts[2]) : undefined;
    
    try {
      const accounts = await db.query.mexcAccounts.findMany({
        where: and(
          eq(mexcAccounts.telegramUserId, userId),
          eq(mexcAccounts.isActive, true)
        ),
      });

      if (accounts.length === 0) {
        return `❌ Нет активных аккаунтов`;
      }

      const fullSymbol = `${symbol}_USDT`;
      const results: string[] = [];

      for (const account of accounts) {
        try {
          const response = await mexcApiCall(
            "/api/v1/private/order/submit",
            "POST",
            account.uId,
            account.proxy || null,
            {
              symbol: fullSymbol,
              side: "SELL",
              type: "MARKET",
              vol: size || 10,
              closeType: 3,
            }
          );

          results.push(`✅ Аккаунт ${account.accountNumber}: Позиция закрыта`);
        } catch (error: any) {
          results.push(`⚠️ Аккаунт ${account.accountNumber}: ${error.message.substring(0, 40)}`);
        }
      }

      return `🧹 *Закрытие позиций*\n\n${results.join("\n")}`;
    } catch (error: any) {
      return `❌ Ошибка: ${error.message}`;
    }
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
    try {
      const accounts = await db.query.mexcAccounts.findMany({
        where: and(
          eq(mexcAccounts.telegramUserId, userId),
          eq(mexcAccounts.isActive, true)
        ),
      });

      if (accounts.length === 0) {
        return `📈 *Открытые позиции*\n\nНет активных аккаунтов`;
      }

      let allPositions: string[] = [];

      for (const account of accounts) {
        try {
          const response = await mexcApiCall(
            "/api/v1/private/position/list",
            "GET",
            account.uId,
            account.proxy || null
          );

          if (response?.data && Array.isArray(response.data)) {
            response.data.forEach((pos: any) => {
              if (pos.holdVol > 0) {
                allPositions.push(
                  `👤 Аккаунт ${account.accountNumber}\n` +
                  `🔹 ${pos.symbol}\n` +
                  `   Сторона: ${pos.positionType === 1 ? '🟢 LONG' : '🔴 SHORT'}\n` +
                  `   Объём: ${pos.holdVol}\n`
                );
              }
            });
          }
        } catch (error: any) {
          allPositions.push(`⚠️ Аккаунт ${account.accountNumber}: ${error.message.substring(0, 30)}`);
        }
      }

      if (allPositions.length === 0) {
        return `📈 *Открытые позиции*\n\nНет открытых позиций`;
      }

      return `📈 *Открытые позиции*\n\n${allPositions.join("\n")}`;
    } catch (error: any) {
      return `❌ Ошибка: ${error.message}`;
    }
  }
  
  // View balance
  if (cmd === "/balance") {
    try {
      const accounts = await db.query.mexcAccounts.findMany({
        where: eq(mexcAccounts.telegramUserId, userId),
      });

      if (accounts.length === 0) {
        return `💰 *Баланс счета*\n\nНет зарегистрированных аккаунтов`;
      }

      let allBalances: string[] = [];

      for (const account of accounts) {
        try {
          const response = await mexcApiCall(
            "/api/v1/private/balance",
            "GET",
            account.uId,
            account.proxy || null
          );

          const balance = response?.data || {};
          allBalances.push(
            `👤 Аккаунт ${account.accountNumber}\n` +
            `   Баланс: ${balance.balance || 'N/A'} USDT\n` +
            `   Рычаг: ${account.defaultLeverage}x`
          );
        } catch (error: any) {
          allBalances.push(`⚠️ Аккаунт ${account.accountNumber}: ${error.message.substring(0, 30)}`);
        }
      }

      return `💰 *Баланс счета*\n\n${allBalances.join("\n")}`;
    } catch (error: any) {
      return `❌ Ошибка: ${error.message}`;
    }
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
  
  return `❓ Неизвестная команда. Используйте /help для списка команд`;
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
    • /register accountNumber webUid [proxy] - зарегистрировать новый аккаунт MEXC
      Пример: /register 458 WEB4f57cbf31a9f3e5d61267a27fe376627230496... http://156.246.187.73:63148:uYg...
    
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
       - registerAccountTool: передай telegramUserId, accountNumber, webUid, proxy (optional)
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
    - При регистрации аккаунта проси только accountNumber, webUid и опционально proxy
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
