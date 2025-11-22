import dotenv from "dotenv";

dotenv.config();

const botToken = process.env.TELEGRAM_BOT_TOKEN;

if (!botToken) {
  console.error("❌ TELEGRAM_BOT_TOKEN not found in environment variables");
  process.exit(1);
}

const commands = [
  {
    command: "start",
    description: "Начать работу с ботом",
  },
  {
    command: "register",
    description: "Зарегистрировать аккаунт MEXC (WEB-UID и прокси)",
  },
  {
    command: "accounts",
    description: "Показать все зарегистрированные аккаунты",
  },
  {
    command: "lm",
    description: "Открыть маркет LONG позицию (пример: /lm BTC 10 20)",
  },
  {
    command: "sm",
    description: "Открыть маркет SHORT позицию (пример: /sm BTC 10 20)",
  },
  {
    command: "l",
    description: "Открыть лимитный LONG ордер (пример: /l 50000 BTC 10 20)",
  },
  {
    command: "s",
    description: "Открыть лимитный SHORT ордер (пример: /s 50000 BTC 10 20)",
  },
  {
    command: "close",
    description: "Закрыть позицию (пример: /close BTC 10)",
  },
  {
    command: "positions",
    description: "Показать все открытые позиции",
  },
  {
    command: "orders",
    description: "Показать все открытые ордера",
  },
  {
    command: "balance",
    description: "Показать баланс счета",
  },
  {
    command: "cancel",
    description: "Отменить ордер (пример: /cancel BTC)",
  },
  {
    command: "settings",
    description: "Обновить настройки аккаунта (пример: /settings 1 20 10)",
  },
];

async function setupCommands() {
  try {
    const url = `https://api.telegram.org/bot${botToken}/setMyCommands`;

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        commands,
      }),
    });

    const data = (await response.json()) as any;

    if (data.ok) {
      console.log("✅ Команды успешно установлены в BotFather!");
      console.log(`📋 Установлено ${commands.length} команд:`);
      commands.forEach((cmd) => {
        console.log(`   • /${cmd.command} - ${cmd.description}`);
      });
    } else {
      console.error("❌ Ошибка при установке команд:");
      console.error(data.description || data);
    }
  } catch (error) {
    console.error("❌ Ошибка при запросе к Telegram API:", error);
    process.exit(1);
  }
}

setupCommands();
