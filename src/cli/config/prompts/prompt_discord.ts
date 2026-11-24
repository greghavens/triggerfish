/**
 * Interactive prompt for Discord channel configuration.
 * @module
 */

import { Input, Select } from "@cliffy/prompt";

/** Print Discord bot setup instructions to the console. */
function printDiscordSetupGuide(): void {
  console.log("\n  To set up a Discord bot:\n");
  console.log("    1. Go to https://discord.com/developers/applications");
  console.log(
    '    2. Click "New Application" \u2192 name it (e.g. "Triggerfish")',
  );
  console.log(
    "    3. Go to Bot in the sidebar \u2192 Reset Token \u2192 copy the token",
  );
  console.log(
    "    4. Enable these Privileged Gateway Intents on the Bot page:",
  );
  console.log("       - Message Content Intent (required to read messages)");
  console.log("       - Server Members Intent (optional, for member lookup)");
  console.log(
    "    5. Go to OAuth2 \u2192 URL Generator \u2192 select 'bot' scope",
  );
  console.log("       Under Bot Permissions, select:");
  console.log("       - Send Messages");
  console.log("       - Read Message History");
  console.log("       - View Channels");
  console.log(
    "    6. Copy the generated URL \u2192 open in browser \u2192 invite bot to your server",
  );
  console.log("");
  console.log("  To find your Discord user ID:");
  console.log("    Settings \u2192 Advanced \u2192 enable Developer Mode");
  console.log("    Then click your username \u2192 Copy User ID\n");
}

/** Prompt for Discord bot token, owner ID, and classification. */
export async function promptDiscordConfig(): Promise<Record<string, unknown>> {
  printDiscordSetupGuide();

  const botToken = await Input.prompt({
    message: "Bot token",
  });

  const discordOwner = await Input.prompt({
    message: "Your Discord user ID (snowflake, strongly recommended)",
    default: "",
  });
  if (discordOwner.length === 0) {
    console.log(
      "\n  WARNING: No owner ID configured. The bot fails closed: EVERY",
    );
    console.log(
      "  sender (including you) is treated as a NON-OWNER with restricted",
    );
    console.log(
      "  access. Set channels.discord.ownerId to claim owner access.\n",
    );
  }

  const classification = await Select.prompt({
    message: "Classification level",
    options: ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"],
    default: "PUBLIC",
  });

  const config: Record<string, unknown> = { botToken, classification };
  if (discordOwner.length > 0) {
    config.ownerId = discordOwner;
  }
  return config;
}
