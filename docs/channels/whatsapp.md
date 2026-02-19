# WhatsApp

Connect your Triggerfish agent to WhatsApp so you can interact with it from your phone. The adapter uses the **WhatsApp Business Cloud API** (the official Meta-hosted HTTP API), receiving messages via webhook and sending via REST.

## Default Classification

WhatsApp defaults to `PUBLIC` classification. WhatsApp contacts can include anyone with your phone number, so `PUBLIC` is the safe default.

## Setup

### Step 1: Create a Meta Business Account

1. Go to the [Meta for Developers](https://developers.facebook.com/) portal
2. Create a developer account if you do not have one
3. Create a new app and select **Business** as the app type
4. In your app dashboard, add the **WhatsApp** product

### Step 2: Get Your Credentials

From the WhatsApp section of your app dashboard, collect these values:

- **Access Token** -- A permanent access token (or generate a temporary one for testing)
- **Phone Number ID** -- The ID of the phone number registered with WhatsApp Business
- **Verify Token** -- A string you choose, used to verify webhook registration

### Step 3: Configure Webhooks

1. In the WhatsApp product settings, navigate to **Webhooks**
2. Set the callback URL to your server's public address (e.g., `https://your-server.com:8443/webhook`)
3. Set the **Verify Token** to the same value you will use in your Triggerfish config
4. Subscribe to the `messages` webhook field

::: info Public URL Required
WhatsApp webhooks require a publicly accessible HTTPS endpoint. If you are running Triggerfish locally, you will need a tunnel service (e.g., ngrok, Cloudflare Tunnel) or a server with a public IP.
:::

### Step 4: Configure Triggerfish

Add the WhatsApp channel to your `triggerfish.yaml`:

```yaml
channels:
  whatsapp:
    # accessToken stored in OS keychain
    phoneNumberId: "your-phone-number-id"
    # verifyToken stored in OS keychain
    ownerPhone: "15551234567"
```

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `accessToken` | string | Yes | WhatsApp Business API access token |
| `phoneNumberId` | string | Yes | Phone Number ID from Meta Business Dashboard |
| `verifyToken` | string | Yes | Token for webhook verification (you choose this) |
| `webhookPort` | number | No | Port to listen for webhooks (default: `8443`) |
| `ownerPhone` | string | Recommended | Your phone number for owner verification (e.g., `"15551234567"`) |
| `classification` | string | No | Classification level (default: `PUBLIC`) |

::: warning Store Secrets Securely
Never commit access tokens to source control. Use environment variables or your OS keychain.
:::

### Step 5: Start Triggerfish

```bash
triggerfish stop && triggerfish start
```

Send a message from your phone to the WhatsApp Business number to confirm the connection.

## Owner Identity

Triggerfish determines owner status by comparing the sender's phone number against the configured `ownerPhone`. This check happens in code before the LLM sees the message:

- **Match** -- The message is an owner command
- **No match** -- The message is external input with `PUBLIC` taint

If no `ownerPhone` is configured, all messages are treated as coming from the owner.

::: tip Always Set Owner Phone
If others may message your WhatsApp Business number, always configure `ownerPhone` to prevent unauthorized command execution.
:::

## How the Webhook Works

The adapter starts an HTTP server on the configured port (default `8443`) that handles two types of requests:

1. **GET /webhook** -- Meta sends this to verify your webhook endpoint. Triggerfish responds with the challenge token if the verify token matches.
2. **POST /webhook** -- Meta sends incoming messages here. Triggerfish parses the Cloud API webhook payload, extracts text messages, and forwards them to the message handler.

## Message Limits

WhatsApp supports messages up to 4,096 characters. Messages exceeding this limit are truncated before sending.

## Typing Indicators

WhatsApp Business Cloud API does not expose a composing/typing signal equivalent to other messaging platforms. Triggerfish does not send typing indicators on WhatsApp.

## Changing Classification

```yaml
channels:
  whatsapp:
    # accessToken stored in OS keychain
    phoneNumberId: "your-phone-number-id"
    # verifyToken stored in OS keychain
    classification: INTERNAL
```

Valid levels: `PUBLIC`, `INTERNAL`, `CONFIDENTIAL`, `RESTRICTED`.
