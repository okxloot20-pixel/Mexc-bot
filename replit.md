# Overview

This project is a Telegram trading bot for MEXC futures trading, built with Mastra. It allows users to execute trades on MEXC via Telegram commands, providing real-time responses and supporting multiple accounts. The bot aims to offer instant, reliable cryptocurrency trading directly from a chat interface.

# User Preferences

Preferred communication style: Simple, everyday language.

# System Architecture

## Fast Command Processing with Real MEXC API

The bot directly parses Telegram commands and executes them via the MEXC API for speed and reliability. It supports multi-account trading, executing commands on all registered accounts simultaneously. Over 15 trading commands are implemented, alongside account management features like registration and listing. Accounts are stored in PostgreSQL, and authentication uses a persistent `u_id` token extracted from MEXC browser cookies.

## Telegram Webhook Integration

The bot integrates with Telegram via a webhook endpoint `/webhooks/telegram/action`, ensuring real-time command processing and responses (typically under 200ms). It features robust command parsing, chat validation, and comprehensive account management UI with inline keyboard buttons for toggling account status and deletion. Auto commands are also supported, allowing users to store automated trading instructions.

## Durable Execution with Inngest

Inngest is used for durable workflow orchestration, providing automatic retries, step memoization, and observability. This ensures reliability for critical trading operations, preventing partial executions and handling temporary API failures.

## Data Persistence

PostgreSQL with the `pgvector` extension is used for data storage, managed by Drizzle ORM for type-safe queries and schema migrations. A shared storage pattern ensures consistent state management across the application.

## Logging and Observability

A custom Pino logger provides structured, high-performance logging with configurable levels and ISO timestamps, essential for debugging and monitoring in a production environment.

## Agent Architecture

The `mexcTradingAgent` interprets Telegram trading signals, executes trades via the MEXC API using a "tools over hardcoded logic" approach, and maintains context with memory. It supports multiple LLM providers (OpenAI, OpenRouter) for flexibility in reasoning and model selection.

## Workflow Design

A `telegramTradingWorkflow` orchestrates the trading pipeline, handling signal reception, validation, trade execution, and confirmation. It utilizes Inngest's branching, parallel execution, and error handling features for robust control flow.

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