import { pgTable, serial, varchar, timestamp, boolean, integer } from "drizzle-orm/pg-core";

/**
 * MEXC Accounts Table
 * Stores multiple MEXC trading accounts with their WEB-UID and proxy settings
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
  webUid: varchar("web_uid", { length: 500 }).notNull(),
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

export type MexcAccount = typeof mexcAccounts.$inferSelect;
export type NewMexcAccount = typeof mexcAccounts.$inferInsert;
