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
    command: "lb",
    description: "LONG лимит по второй цене на продажу (BBO)",
  },
  {
    command: "sb",
    description: "SHORT лимит по второй цене на покупку (BBO)",
  },
  {
    command: "lm",
    description: "LONG маркет",
  },
  {
    command: "sm",
    description: "SHORT маркет",
  },
  {
    command: "sl",
    description: "SHORT лимит лесенкой",
  },
  {
    command: "close",
    description: "Закрыть позицию по маркету",
  },
  {
    command: "closebs",
    description: "Закрыть SHORT по второй цене на продажу (BBO)",
  },
  {
    command: "positions",
    description: "Открытые позиции",
  },
  {
    command: "balance",
    description: "Баланс",
  },
  {
    command: "register",
    description: "Регистрация аккаунтов",
  },
  {
    command: "accounts",
    description: "Мои аккаунты",
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
