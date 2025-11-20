# Cloudflare Incidents Bot for Google Chat

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/YOUR_USERNAME/cf-incidents-bots)

A Cloudflare Worker that monitors the Cloudflare Status page and posts notifications to Google Chat when new incidents are detected.

## Features

- Checks Cloudflare Status API every 5 minutes
- Only posts notifications for actual incidents (not scheduled maintenance)
- Color-coded messages based on incident severity:
  - 🔴 **Critical**: Red
  - 🟠 **Major**: Orange
  - 🟡 **Minor**: Yellow
  - ⚪ **None**: Grey
- Tracks reported incidents using KV storage to avoid duplicate notifications
- Rich Google Chat card format with incident details and links

## Setup

### Prerequisites

- Node.js and npm installed
- Cloudflare account with Workers enabled
- Wrangler CLI installed
- Google Chat space with webhook access

### Setting Up Google Chat Webhook

Before deploying the worker, you need to create a Google Chat webhook:

1. **Create or Open a Google Chat Space**:
   - Open [Google Chat](https://chat.google.com)
   - Create a new space or select an existing one where you want to receive incident notifications
   - Click on the space name at the top

2. **Configure Incoming Webhooks**:
   - Click on **"Apps & integrations"** (or the three-dot menu > **"Apps & integrations"**)
   - Click **"Add webhooks"**
   - Enter a name for the webhook (e.g., "Cloudflare Incidents Bot")
   - Optionally, add an avatar URL or emoji
   - Click **"Save"**

3. **Copy the Webhook URL**:
   - After saving, you'll see a webhook URL that looks like:
     ```
     https://chat.googleapis.com/v1/spaces/SPACE_ID/messages?key=KEY&token=TOKEN
     ```
   - Copy this entire URL - you'll need it during deployment
   - Keep this URL secure as anyone with access can post messages to your space

4. **Test the Webhook (Optional)**:
   ```bash
   curl -X POST 'YOUR_WEBHOOK_URL' \
   -H 'Content-Type: application/json' \
   -d '{"text": "Test message from Cloudflare Incidents Bot"}'
   ```

### Installation

1. Install dependencies:
   ```bash
   npm install
   ```

2. Create a KV namespace for tracking incidents:
   ```bash
   wrangler kv namespace create "INCIDENTS_KV"
   ```

3. Update `wrangler.jsonc` with your KV namespace ID and account ID

4. Set the Google Chat webhook secret:
   ```bash
   wrangler secret put GOOGLE_CHAT_WEBHOOK
   ```
   Then paste your Google Chat webhook URL when prompted.

5. Deploy to Cloudflare:
   ```bash
   npm run deploy
   ```

## Configuration

### Google Chat Webhook

The Google Chat webhook URL is stored as a secret. To update it:

1. Create a webhook in your Google Chat space
2. Set the secret:
   ```bash
   wrangler secret put GOOGLE_CHAT_WEBHOOK
   ```
3. Paste your webhook URL when prompted

### Cloudflare Status API

The API URL is configured as an environment variable in `wrangler.jsonc`:
```jsonc
"vars": {
  "STATUS_API_URL": "https://www.cloudflarestatus.com/api/v2/incidents/unresolved.json"
}
```

### Schedule

The worker runs every 5 minutes by default. To change the schedule, update the cron expression in `wrangler.jsonc`:

```jsonc
"triggers": {
  "crons": ["*/5 * * * *"]
}
```

## Testing

### Manual Trigger

You can manually trigger the worker by making a GET request to the worker URL:

```bash
curl https://cf-incidents-bot.<your-subdomain>.workers.dev
```

This will:
- Fetch current incidents
- Check which ones are new
- Send notifications for new incidents
- Return a JSON response with the results

### Local Development

Run the worker locally:

```bash
npm run dev
```

## How It Works

1. **Scheduled Execution**: The worker runs every 5 minutes via Cloudflare Cron Triggers
2. **Fetch Incidents**: Queries the Cloudflare Status API for unresolved incidents
3. **Check for New Incidents**: Uses KV storage to track which incidents have been reported
4. **Send Notifications**: Posts new incidents to Google Chat with rich card formatting
5. **Track Incidents**: Stores incident IDs in KV for 30 days to prevent duplicates

## API Endpoints Used

- **Cloudflare Status API**: `https://www.cloudflarestatus.com/api/v2/incidents/unresolved.json`
- **Google Chat Webhook**: Configured webhook URL

## Deployment

To deploy the worker:

1. Make sure you're authenticated with the correct account:
   ```bash
   wrangler whoami
   ```

2. Update the `account_id` in `wrangler.jsonc`

3. Deploy:
   ```bash
   npm run deploy
   ```

### Environment Bindings

The worker requires these bindings:
- **`INCIDENTS_KV`**: KV namespace for tracking reported incidents
- **`STATUS_API_URL`**: Environment variable (configured in `wrangler.jsonc`)
- **`GOOGLE_CHAT_WEBHOOK`**: Secret (set via `wrangler secret put`)

## License

This project is licensed under the GNU General Public License v3.0 - see the [LICENSE](LICENSE) file for details.
