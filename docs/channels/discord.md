# Discord

Connect your Triggerfish agent to Discord so it can respond in server channels and direct messages. The adapter uses [discord.js](https://discord.js.org/) to connect to the Discord Gateway.

## Default Classification

Discord defaults to `PUBLIC` classification. Discord servers often include a mix of trusted members and public visitors, so `PUBLIC` is the safe default. You can raise this if your server is private and trusted.

## Setup

### Step 1: Create a Discord Application

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**
3. Name your application (e.g., "Triggerfish")
4. Click **Create**

### Step 2: Create a Bot User

1. In your application, navigate to **Bot** in the sidebar
2. Click **Add Bot** (if not already created)
3. Under the bot's username, click **Reset Token** to generate a new token
4. Copy the **bot token**

::: warning Keep Your Token Secret
Your bot token grants full control of your bot. Never commit it to source control or share it publicly.
:::

### Step 3: Configure Privileged Intents

Still on the **Bot** page, enable these privileged gateway intents:

- **Message Content Intent** -- Required to read message content
- **Server Members Intent** -- Optional, for member lookup

### Step 4: Get Your Discord User ID

1. Open Discord
2. Go to **Settings** > **Advanced** and enable **Developer Mode**
3. Click your username anywhere in Discord
4. Click **Copy User ID**

This is the snowflake ID that Triggerfish uses to verify owner identity.

### Step 5: Generate an Invite Link

1. In the Developer Portal, navigate to **OAuth2** > **URL Generator**
2. Under **Scopes**, select `bot`
3. Under **Bot Permissions**, select:
   - Send Messages
   - Read Message History
   - View Channels
4. Copy the generated URL and open it in your browser
5. Select the server you want to add the bot to and click **Authorize**

### Step 6: Configure Triggerfish

Add the Discord channel to your `triggerfish.yaml`:

```yaml
channels:
  discord:
    # botToken stored in OS keychain
    ownerId: "123456789012345678"
```

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `botToken` | string | Yes | Discord bot token |
| `ownerId` | string | Recommended | Your Discord user ID (snowflake) for owner verification |
| `classification` | string | No | Classification level (default: `PUBLIC`) |

### Step 7: Start Triggerfish

```bash
triggerfish stop && triggerfish start
```

Send a message in a channel where the bot is present, or DM it directly, to confirm the connection.

## Owner Identity

Triggerfish determines owner status by comparing the sender's Discord user ID against the configured `ownerId`. This check happens in code before the LLM sees the message:

- **Match** -- The message is an owner command
- **No match** -- The message is external input with `PUBLIC` taint

If no `ownerId` is configured, all messages are treated as coming from the owner.

::: tip Always Set Owner ID
If your bot is in a server with other members, always configure `ownerId`. Without it, any server member can issue commands to your agent.
:::

## Message Chunking

Discord has a 2,000-character message limit. When the agent generates a response longer than this, Triggerfish automatically splits it into multiple messages. The chunker splits on newlines or spaces to preserve readability.

## Bot Behavior

The Discord adapter:

- **Ignores its own messages** -- The bot will not respond to messages it sends
- **Listens in all accessible channels** -- Guild channels, group DMs, and direct messages
- **Requires Message Content Intent** -- Without this, the bot receives empty message events

## Typing Indicators

Triggerfish sends typing indicators to Discord when the agent is processing a request. Discord does not expose typing events from users to bots in a reliable way, so this is send-only.

## Group Chat

The bot can participate in server channels. Configure group behavior:

```yaml
groups:
  default_behavior: "mentioned-only"
  overrides:
    - channel: discord
      behavior: "always"
```

| Behavior | Description |
|----------|-------------|
| `mentioned-only` | Only respond when the bot is @mentioned |
| `always` | Respond to all messages in the channel |

## Changing Classification

```yaml
channels:
  discord:
    # botToken stored in OS keychain
    ownerId: "123456789012345678"
    classification: INTERNAL
```

Valid levels: `PUBLIC`, `INTERNAL`, `CONFIDENTIAL`, `RESTRICTED`.
