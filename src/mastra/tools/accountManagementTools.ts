import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { db } from "../storage/db";
import { mexcAccounts } from "../storage/schema";
import { eq, and } from "drizzle-orm";

/**
 * Account Management Tools
 * Tools for managing MEXC trading accounts via Telegram
 */

/**
 * Tool: Register New Account
 * Adds a new MEXC account with u_id and proxy
 */
export const registerAccountTool = createTool({
  id: "register-account",
  description: "Registers a new MEXC trading account with u_id from browser cookies and optional proxy",
  inputSchema: z.object({
    telegramUserId: z.string().describe("Telegram user ID"),
    telegramUsername: z.string().optional().describe("Telegram username"),
    accountNumber: z.number().describe("Account number (e.g., 458, 459)"),
    uId: z.string().describe("u_id from MEXC browser cookies (DevTools → Application → Cookies)"),
    proxy: z.string().optional().describe("Proxy URL (optional, format: http://ip:port)"),
    defaultLeverage: z.number().optional().describe("Default leverage (optional, default: 20)"),
    defaultSize: z.number().optional().describe("Default position size (optional, default: 10)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    accountId: z.number().optional(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('📝 [registerAccountTool] Registering new account', {
      accountNumber: context.accountNumber,
      telegramUserId: context.telegramUserId,
    });

    try {
      // Check if account number already exists for this user
      const existing = await db.query.mexcAccounts.findFirst({
        where: and(
          eq(mexcAccounts.telegramUserId, context.telegramUserId),
          eq(mexcAccounts.accountNumber, context.accountNumber)
        ),
      });

      if (existing) {
        return {
          success: false,
          message: `Аккаунт ${context.accountNumber} уже существует. Используйте команду обновления.`,
        };
      }

      // Insert new account
      const [newAccount] = await db.insert(mexcAccounts).values({
        telegramUserId: context.telegramUserId,
        telegramUsername: context.telegramUsername,
        accountNumber: context.accountNumber,
        uId: context.uId,
        proxy: context.proxy,
        defaultLeverage: context.defaultLeverage || 20,
        defaultSize: context.defaultSize || 10,
        isActive: true,
      }).returning();

      logger?.info('✅ [registerAccountTool] Account registered successfully', {
        accountId: newAccount.id,
      });

      return {
        success: true,
        accountId: newAccount.id,
        message: `✅ Аккаунт ${context.accountNumber} успешно зарегистрирован!\nu_id: ${context.uId.substring(0, 20)}...\n${context.proxy ? `Proxy: ${context.proxy}` : 'Proxy: не указан'}`,
      };
    } catch (error: any) {
      logger?.error('❌ [registerAccountTool] Error registering account', {
        error: error.message,
      });
      return {
        success: false,
        message: `Ошибка при регистрации аккаунта: ${error.message}`,
      };
    }
  },
});

/**
 * Tool: List User Accounts
 * Shows all MEXC accounts for the user
 */
export const listAccountsTool = createTool({
  id: "list-accounts",
  description: "Lists all MEXC trading accounts for the user with their settings",
  inputSchema: z.object({
    telegramUserId: z.string().describe("Telegram user ID"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    accounts: z.array(z.object({
      accountNumber: z.number(),
      uId: z.string(),
      proxy: z.string().optional(),
      defaultLeverage: z.number(),
      defaultSize: z.number(),
      isActive: z.boolean(),
    })).optional(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('📋 [listAccountsTool] Listing accounts', {
      telegramUserId: context.telegramUserId,
    });

    try {
      const accounts = await db.query.mexcAccounts.findMany({
        where: eq(mexcAccounts.telegramUserId, context.telegramUserId),
        orderBy: (mexcAccounts, { asc }) => [asc(mexcAccounts.accountNumber)],
      });

      if (accounts.length === 0) {
        return {
          success: true,
          accounts: [],
          message: "У вас нет зарегистрированных аккаунтов. Используйте /register для добавления аккаунта.",
        };
      }

      logger?.info('✅ [listAccountsTool] Accounts retrieved', {
        count: accounts.length,
      });

      return {
        success: true,
        accounts: accounts.map(acc => ({
          accountNumber: acc.accountNumber,
          uId: acc.uId,
          proxy: acc.proxy || undefined,
          defaultLeverage: acc.defaultLeverage || 20,
          defaultSize: acc.defaultSize || 10,
          isActive: acc.isActive || false,
        })),
        message: `Найдено ${accounts.length} аккаунт(ов)`,
      };
    } catch (error: any) {
      logger?.error('❌ [listAccountsTool] Error listing accounts', {
        error: error.message,
      });
      return {
        success: false,
        message: `Ошибка при получении списка аккаунтов: ${error.message}`,
      };
    }
  },
});

/**
 * Tool: Toggle Account Status
 * Activates or deactivates an account
 */
export const toggleAccountStatusTool = createTool({
  id: "toggle-account-status",
  description: "Activates or deactivates a MEXC trading account",
  inputSchema: z.object({
    telegramUserId: z.string().describe("Telegram user ID"),
    accountNumber: z.number().describe("Account number to toggle"),
    activate: z.boolean().describe("True to activate, false to deactivate"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🔄 [toggleAccountStatusTool] Toggling account status', {
      accountNumber: context.accountNumber,
      activate: context.activate,
    });

    try {
      const result = await db
        .update(mexcAccounts)
        .set({
          isActive: context.activate,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(mexcAccounts.telegramUserId, context.telegramUserId),
            eq(mexcAccounts.accountNumber, context.accountNumber)
          )
        )
        .returning();

      if (result.length === 0) {
        return {
          success: false,
          message: `Аккаунт ${context.accountNumber} не найден.`,
        };
      }

      logger?.info('✅ [toggleAccountStatusTool] Account status updated');

      return {
        success: true,
        message: `${context.activate ? '✅' : '❌'} Аккаунт ${context.accountNumber} ${context.activate ? 'активирован' : 'деактивирован'}`,
      };
    } catch (error: any) {
      logger?.error('❌ [toggleAccountStatusTool] Error toggling status', {
        error: error.message,
      });
      return {
        success: false,
        message: `Ошибка при изменении статуса аккаунта: ${error.message}`,
      };
    }
  },
});

/**
 * Tool: Update Account Settings
 * Updates default leverage and size for an account
 */
export const updateAccountSettingsTool = createTool({
  id: "update-account-settings",
  description: "Updates default trading settings (leverage, size) for a MEXC account",
  inputSchema: z.object({
    telegramUserId: z.string().describe("Telegram user ID"),
    accountNumber: z.number().describe("Account number to update"),
    defaultLeverage: z.number().optional().describe("New default leverage"),
    defaultSize: z.number().optional().describe("New default position size"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('⚙️  [updateAccountSettingsTool] Updating account settings', {
      accountNumber: context.accountNumber,
    });

    try {
      const updates: any = {
        updatedAt: new Date(),
      };

      if (context.defaultLeverage !== undefined) {
        updates.defaultLeverage = context.defaultLeverage;
      }
      if (context.defaultSize !== undefined) {
        updates.defaultSize = context.defaultSize;
      }

      const result = await db
        .update(mexcAccounts)
        .set(updates)
        .where(
          and(
            eq(mexcAccounts.telegramUserId, context.telegramUserId),
            eq(mexcAccounts.accountNumber, context.accountNumber)
          )
        )
        .returning();

      if (result.length === 0) {
        return {
          success: false,
          message: `Аккаунт ${context.accountNumber} не найден.`,
        };
      }

      logger?.info('✅ [updateAccountSettingsTool] Settings updated');

      return {
        success: true,
        message: `✅ Настройки аккаунта ${context.accountNumber} обновлены:\n${context.defaultLeverage ? `Плечо: ${context.defaultLeverage}x\n` : ''}${context.defaultSize ? `Размер: ${context.defaultSize}` : ''}`,
      };
    } catch (error: any) {
      logger?.error('❌ [updateAccountSettingsTool] Error updating settings', {
        error: error.message,
      });
      return {
        success: false,
        message: `Ошибка при обновлении настроек: ${error.message}`,
      };
    }
  },
});

/**
 * Tool: Get Account Credentials
 * Internal tool to retrieve account credentials for trading operations
 */
export const getAccountCredentialsTool = createTool({
  id: "get-account-credentials",
  description: "Retrieves u_id and proxy for active MEXC accounts",
  inputSchema: z.object({
    telegramUserId: z.string().describe("Telegram user ID"),
    accountNumber: z.number().optional().describe("Specific account number (optional, returns all active if not provided)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    accounts: z.array(z.object({
      accountNumber: z.number(),
      uId: z.string(),
      proxy: z.string().optional(),
      defaultLeverage: z.number(),
      defaultSize: z.number(),
    })).optional(),
    message: z.string(),
  }),
  execute: async ({ context, mastra }) => {
    const logger = mastra?.getLogger();
    logger?.info('🔐 [getAccountCredentialsTool] Retrieving credentials', {
      telegramUserId: context.telegramUserId,
      accountNumber: context.accountNumber,
    });

    try {
      const whereConditions = [
        eq(mexcAccounts.telegramUserId, context.telegramUserId),
        eq(mexcAccounts.isActive, true),
      ];

      if (context.accountNumber !== undefined) {
        whereConditions.push(eq(mexcAccounts.accountNumber, context.accountNumber));
      }

      const accounts = await db.query.mexcAccounts.findMany({
        where: and(...whereConditions),
      });

      if (accounts.length === 0) {
        return {
          success: false,
          message: "Активные аккаунты не найдены.",
        };
      }

      logger?.info('✅ [getAccountCredentialsTool] Credentials retrieved', {
        count: accounts.length,
      });

      return {
        success: true,
        accounts: accounts.map(acc => ({
          accountNumber: acc.accountNumber,
          uId: acc.uId,
          proxy: acc.proxy || undefined,
          defaultLeverage: acc.defaultLeverage || 20,
          defaultSize: acc.defaultSize || 10,
        })),
        message: `Получены данные для ${accounts.length} активных аккаунтов`,
      };
    } catch (error: any) {
      logger?.error('❌ [getAccountCredentialsTool] Error retrieving credentials', {
        error: error.message,
      });
      return {
        success: false,
        message: `Ошибка при получении данных аккаунтов: ${error.message}`,
      };
    }
  },
});
