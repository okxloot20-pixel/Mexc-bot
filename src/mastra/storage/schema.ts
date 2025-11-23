import { pgTable, serial, varchar, timestamp, boolean, integer } from "drizzle-orm/pg-core";

/**
 * MEXC Accounts Table
 * Stores multiple MEXC trading accounts with their u_id and proxy settings
 */
export const mexcAccounts = pgTable("mexc_accounts", {
  id: serial("id").primaryKey(),
  
  // User identification
  telegramUserId: varchar("telegram_user_id", { length: 255 }).notNull(),
  telegramUsername: varchar("telegram_username", { length: 255 }),
  
  // Account identification
  accountNumber: integer("account_number").notNull(), // User-friendly account number (458, 459, etc.)
  accountName: varchar("account_name", { length: 255 }), // Optional custom name
  
  // MEXC credentials
  uId: varchar("u_id", { length: 500 }).notNull(),
  proxy: varchar("proxy", { length: 500 }), // Optional proxy URL
  
  // Trading settings (defaults)
  defaultLeverage: integer("default_leverage").default(20),
  defaultSize: integer("default_size").default(10),
  
  // Account status
  isActive: boolean("is_active").default(true),
  
  // Timestamps
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Symbol Limits Table
 * Stores maximum contract limits for each trading symbol
 * Example: ARTX_USDT has max 75 contracts
 */
export const symbolLimits = pgTable("symbol_limits", {
  id: serial("id").primaryKey(),
  
  // Symbol name (e.g., ARTX_USDT, BTC_USDT)
  symbol: varchar("symbol", { length: 50 }).notNull().unique(),
  
  // Maximum contracts allowed for this symbol
  maxContracts: integer("max_contracts").notNull().default(100),
  
  // Timestamps
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

/**
 * Fast Commands Table
 * Stores user-defined fast commands/text
 */
export const fastCommands = pgTable("fast_commands", {
  id: serial("id").primaryKey(),
  
  // User identification
  telegramUserId: varchar("telegram_user_id", { length: 255 }).notNull().unique(),
  
  // Command text
  text: varchar("text", { length: 2000 }).notNull().default(""),
  
  // Timestamps
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export type MexcAccount = typeof mexcAccounts.$inferSelect;
export type NewMexcAccount = typeof mexcAccounts.$inferInsert;
export type SymbolLimit = typeof symbolLimits.$inferSelect;
export type NewSymbolLimit = typeof symbolLimits.$inferInsert;
export type FastCommand = typeof fastCommands.$inferSelect;
export type NewFastCommand = typeof fastCommands.$inferInsert;
