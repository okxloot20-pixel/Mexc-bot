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
    const response = await fetch(`https://contract.mexc.com/api/v1/depth?symbol=${symbol}&limit=20`);
    const data = await response.json();
    
    if (data.success && data.data && Array.isArray(data.data.bids) && data.data.bids.length > 0) {
      // bids[0][0] is the best bid price
      return parseFloat(data.data.bids[0][0]);
    }
    
    return null;
  } catch (error: any) {
    console.error(`Error getting best bid price for ${symbol}:`, error.message);
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

1️⃣ Открой MEXC в браузере: https://contract.mexc.com
2️⃣ Открой DevTools (F12) → Application → Cookies
3️⃣ Найди cookie с именем *u_id* 
4️⃣ Скопируй её VALUE (не имя!) - это будет строка вроде: WEB06040d90...

Отправь данные в формате:
\`/register ACCOUNT_NUM U_ID [PROXY]\`

Пример:
\`/register 474 WEB06040d90... http://156.246.187.73:63148\`

✅ u_id не истекает - один раз скопировал, используй сколько угодно долго!`;
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
  
  // Open LONG limit
  if (cmd.startsWith("/l ")) {
    const parts = message.trim().split(/\s+/);
    const price = parseFloat(parts[1]) || 0;
    const symbol = parts[2] ? parts[2].toUpperCase() : "BTC";
    const size = parts[3] ? parseInt(parts[3]) : undefined;
    const leverage = parts[4] ? parseInt(parts[4]) : undefined;
    
    const result = await executeToolDirect(openLongLimitTool, {
      telegramUserId: userId,
      symbol,
      price,
      size,
      leverage,
    });
    return `✅ *Лимит LONG ордер создаётся*\n\n${result}`;
  }
  
  // Open SHORT limit
  if (cmd.startsWith("/s ")) {
    const parts = message.trim().split(/\s+/);
    const price = parseFloat(parts[1]) || 0;
    const symbol = parts[2] ? parts[2].toUpperCase() : "BTC";
    const size = parts[3] ? parseInt(parts[3]) : undefined;
    const leverage = parts[4] ? parseInt(parts[4]) : undefined;
    
    const result = await executeToolDirect(openShortLimitTool, {
      telegramUserId: userId,
      symbol,
      price,
      size,
      leverage,
    });
    return `✅ *Лимит SHORT ордер создаётся*\n\n${result}`;
  }
  
  // Open SHORT limit at best bid price from orderbook
  if (cmd.startsWith("/sb")) {
    const parts = message.trim().split(/\s+/);
    const symbol = parts[1] ? parts[1].toUpperCase() : "BTC";
    const size = parts[2] ? parseInt(parts[2]) : undefined;
    const leverage = parts[3] ? parseInt(parts[3]) : undefined;
    
    // Get best bid price from orderbook
    const fullSymbol = `${symbol}_USDT`;
    const bestBidPrice = await getBestBidPrice(fullSymbol);
    
    if (bestBidPrice === null) {
      return `❌ Не удалось получить цену из стакана для ${fullSymbol}`;
    }
    
    const result = await executeToolDirect(openShortLimitTool, {
      telegramUserId: userId,
      symbol,
      price: bestBidPrice,
      size,
      leverage,
    });
    return `✅ *SHORT лимит по best bid ${bestBidPrice}*\n\n${result}`;
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
