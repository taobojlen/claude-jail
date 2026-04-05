# claude-jail

A sandboxed Docker container for running a persistent Claude Code agent via [Channels](https://code.claude.com/docs/en/channels-reference). Claude has full sudo access inside the container but cannot escape it. You interact through Matrix, but can alternatively use claude.ai/code or the Claude mobile app (or you can write any other integration you like).

Full walkthrough/dev log [here](https://btao.org/notes/eMKFWBU1wnfTJczfo55f1/).

## Quick start

```bash
# First time: authenticate (interactive, one-shot)
docker compose run --rm -it claude login

# Start the remote control server
docker compose up --build -d
```

Then open [claude.ai/code](https://claude.ai/code) or the Claude mobile app — the session appears in your session list.

## First run

On the very first launch, Claude Code has no credentials:

1. `docker compose run --rm -it claude login`
2. Claude will prompt you to log in — run `/login` and select option 1 ("Claude account with subscription")
3. Follow the URL in your browser and authenticate. **Important:** The login URL may wrap in the terminal — remove any spaces inserted by line wrapping before pasting into your browser, or the redirect will fail.
4. Once logged in, exit the session (Ctrl-C) and start the server: `docker compose up --build -d`

OAuth tokens persist in a named Docker volume (`claude-home`). You only need to log in once.

## Matrix bridge setup

The Matrix bridge lets you DM your Claude bot over an E2EE Matrix chat.

1. **Create a bot account** on your Matrix homeserver (or use an existing one)
2. **Get an access token** — in Element: Settings → Help & About → Access Token
3. **Configure environment** — copy `.env.example` to `.env` and fill in:
   ```
   MATRIX_HOMESERVER_URL=https://matrix.example.com
   MATRIX_ACCESS_TOKEN=syt_your_access_token_here
   MATRIX_USER_ID=@yourusername:example.com
   ```
4. **Start everything**: `docker compose up --build -d`
5. **DM the bot** from your Matrix account — it auto-joins and starts forwarding messages to Claude

The bot only responds to DMs from the configured `MATRIX_USER_ID`. Crypto keys persist across restarts in the `matrix-data` volume.

### Verifying the bot's E2EE session

Element will show the bot's SDK session as unverified. To cross-sign it:

1. Log into Element as the bot account and set up cross-signing (Security & Privacy)
2. Save the recovery key Element gives you
3. Add to `.env`:
   ```
   MATRIX_RECOVERY_KEY=your recovery key here
   ```
4. Run the verification script:
   ```bash
   docker compose cp matrix/verify-bot.ts matrix:/app/verify-bot.ts
   docker compose exec -e MATRIX_RECOVERY_KEY="$MATRIX_RECOVERY_KEY" matrix bun run /app/verify-bot.ts
   ```
5. Refresh Element — the SDK session should now show as verified

## Configuration

| Environment variable | Default | Description |
|---|---|---|
| `PROJECT_DIR` | `/home/ubuntu/workspace` | Working directory for Claude |
| `SCHEDULER_API_PORT` | `8791` | Scheduler HTTP API port |
| `SCHEDULER_CHANNEL_PORT` | `8790` | MCP channel HTTP listener port |
| `MATRIX_HOMESERVER_URL` | — | Matrix homeserver URL (required for Matrix) |
| `MATRIX_ACCESS_TOKEN` | — | Bot's Matrix access token (required for Matrix) |
| `MATRIX_USER_ID` | — | Your Matrix user ID to accept DMs from (required for Matrix) |
| `MATRIX_API_PORT` | `8793` | Matrix bot HTTP API port |
| `MATRIX_CHANNEL_PORT` | `8792` | Matrix MCP channel HTTP listener port |

## Managing the container

```bash
# Stop (won't auto-restart)
docker compose stop

# Stop and remove container (volume persists)
docker compose down

# Nuclear reset — wipes all state including auth
docker compose down -v
```
