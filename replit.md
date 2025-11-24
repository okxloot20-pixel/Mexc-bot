# Overview

This project is a Telegram trading bot for MEXC futures trading, built with Mastra. It allows users to execute trades on MEXC via Telegram commands, providing real-time responses and supporting multiple accounts. The bot includes automatic spread-based SHORT trading that monitors price differences between MEXC futures and DEX markets. The bot aims to offer instant, reliable cryptocurrency trading directly from a chat interface.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Fast Command Processing with Real MEXC API

The bot directly parses Telegram commands and executes them via the MEXC API for speed and reliability. It supports multi-account trading, executing commands on all registered accounts simultaneously. Over 15 trading commands are implemented, alongside account management features like registration and listing. Accounts are stored in PostgreSQL, and authentication uses a persistent `u_id` token extracted from MEXC browser cookies.

## Telegram Webhook Integration

The bot integrates with Telegram via a webhook endpoint `/webhooks/telegram/action`, ensuring real-time command processing and responses (typically under 200ms). It features robust command parsing, chat validation, and comprehensive account management UI with inline keyboard buttons for toggling account status and deletion. Auto commands are fully supported with `/auto add SYMBOL dex_address` for adding and "🗑️ Удалить" button for removing saved automated trading instructions. Main reply_keyboard features buttons for quick navigation: 🚀 Начало, 📊 Позиции, 👤 Аккаунт, 📦 Ордеры, 💰 Баланс, ⚡ Fast, 🔄 Авто, ⚙️ Настройки, 🚨 Сигналы.

## Durable Execution with Inngest

Inngest is used for durable workflow orchestration, providing automatic retries, step memoization, and observability. This ensures reliability for critical trading operations, preventing partial executions and handling temporary API failures.

## Data Persistence

PostgreSQL with the `pgvector` extension is used for data storage, managed by Drizzle ORM for type-safe queries and schema migrations. A shared storage pattern ensures consistent state management across the application.

## Logging and Observability

A custom Pino logger provides structured, high-performance logging with configurable levels and ISO timestamps, essential for debugging and monitoring in a production environment.

## Spread-Based Automated SHORT Trading

Background monitoring module automatically tracks coins from `/auto` list and executes shorts when MEXC/DEX spread >= 13%. Key features:
- **Entry**: Automatic SHORT market order when spread >= 13% AND mexcPrice > dexPrice
- **Exit**: Automatic close via /closebs when spread < 2%
- **Hysteresis**: Prevents re-entry until spread drops < 7% (gisterzesis prevents false signals)
- **Commands**: `/spread_on` enables, `/spread_off` disables, `/auto add SYMBOL dexPairId` configures
- **Monitoring interval**: 15 seconds per iteration
- **Notifications**: Auto-sends Telegram messages when trades are executed

## Agent Architecture

The `mexcTradingAgent` interprets Telegram trading signals, executes trades via the MEXC API using a "tools over hardcoded logic" approach, and maintains context with memory. It supports multiple LLM providers (OpenAI, OpenRouter) for flexibility in reasoning and model selection.

## Workflow Design

A `telegramTradingWorkflow` orchestrates the trading pipeline, handling signal reception, validation, trade execution, and confirmation. It utilizes Inngest's branching, parallel execution, and error handling features for robust control flow.

## Recent Changes (November 24, 2025)

- ✅ Added "🔄 Авто" button to reply_keyboard (main menu structure)
- ✅ Implemented spread monitoring service with hysteresis logic
- ✅ Added /spread_on and /spread_off commands for monitoring control
- ✅ Background monitoring job runs every 15 seconds checking configured symbols
- ✅ Auto SHORT entries when spread >= 13% AND mexcPrice > dexPrice
- ✅ Auto SHORT exits when spread < 2%
- ✅ Hysteresis prevents re-entry until spread < 7%
- ✅ Database schema updated with spread_monitoring_enabled flag and spread_monitoring_state table
- ⚠️ Removed unstable DEBUG commands that interfered with message processing
- ✅ **CRITICAL FIX:** Webhook URL was pointing to Inngest instead of Mastra endpoint
- ✅ **CRITICAL FIX v2:** Webhook not set on production - added auto-detection and TELEGRAM_WEBHOOK_URL env var
- ✅ Fixed webhook URL to: `https://e78e0794-a7b9-4eb7-91fc-56aa86108949-00-7aa5pyjb3lka.worf.replit.dev/webhooks/telegram/action`
- ✅ Restored callback_query (button click) handling without conflicts
- ✅ Bot fully STABLE: All text commands work + Button menus work
- ✅ All trading commands work: /start, /balance, /positions, /accounts, /orders, /help, /fast, /auto, /sp_on, /sp_off, etc.
- ✅ Button clicks (inline keyboards) now respond immediately
- ✅ **PRODUCTION READY**: Webhook auto-configures from TELEGRAM_WEBHOOK_URL env var on startup
- ✅ Bot verified working on Reserved VM with production webhook

# External Dependencies

## Third-Party Services
- **MEXC Exchange API**: For executing cryptocurrency trades.
- **Telegram Bot API**: For receiving commands and sending responses.
- **Exa**: For external data retrieval and market research.
- **Slack API**: For alternative messaging integrations.

## AI/LLM Providers
- **OpenAI**: Primary LLM provider (GPT-4o, GPT-4o-mini).
- **OpenRouter**: Multi-provider gateway for diverse LLM access and fallback.

## Infrastructure Services
- **Inngest Cloud**: For workflow orchestration, monitoring, and durable execution.
- **PostgreSQL Database**: Primary data store, utilizing `pgvector` for semantic search.

## Development Tools
- **Drizzle Kit**: For database schema management and migrations.
- **TSX**: To execute TypeScript directly during development.