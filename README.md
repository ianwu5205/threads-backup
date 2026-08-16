# threads-backup

Back up your own Threads posts and attached images, videos, GIFs, thumbnails,
and carousel media with the official Threads API.

[Open the illustrated setup guide](guide/index.html).

## Requirements

- Node.js 24 or newer
- A Meta app with the **Threads API** use case
- `cloudflared` when using the default Quick Tunnel login flow

Use the Threads App ID and Threads App Secret shown in the Meta dashboard.
They are not the app's general Facebook credentials. In development mode, add
your Threads account as an app tester and accept the invitation in Threads.

## Install

```sh
npm install --global threads-backup
```

Create a `.env` file in the directory where backups should be saved:

```dotenv
THREADS_APP_ID=your_threads_app_id
THREADS_APP_SECRET=your_threads_app_secret
PORT=8787
```

The CLI stores credentials in `.credentials/` and backups in `backups/` in that
same directory. Do not commit any of these files.

## First login with a Quick Tunnel

Install `cloudflared` if it is not already on `PATH`:

```sh
# macOS
brew install cloudflared

# Windows
winget install --id Cloudflare.cloudflared
```

Run the CLI:

```sh
threads-backup
```

When authorization is needed, the CLI starts a local callback server and runs:

```sh
cloudflared tunnel --url http://127.0.0.1:8787 --no-autoupdate --output json
```

The CLI prints a callback such as:

```text
https://random-words.trycloudflare.com/oauth/callback
```

Add that exact URL under **Meta App > Threads API > Redirect Callback URLs**,
return to the terminal, and press Enter. Open the authorization URL printed by
the CLI. After login, the CLI exchanges the code for a long-lived token, looks
up the Threads username, saves it to `.credentials/{username}.json`, stops its
tunnel, and immediately starts the backup.

Quick Tunnel hostnames are random and intended for development or testing. A
new callback must be registered whenever a new Quick Tunnel is needed. The CLI
normally avoids this by refreshing an unexpired long-lived token before it
expires. See [Cloudflare's Quick Tunnel documentation](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).

## Fixed callback URL

For a callback that only needs to be registered once, run a named or remotely
managed Cloudflare Tunnel separately and add its HTTPS URL to `.env`:

```dotenv
THREADS_REDIRECT_URI=https://threads-backup.example.com/oauth/callback
CLOUDFLARED_TUNNEL=threads-backup
```

The fixed tunnel's public hostname must use the same URL and route to
`http://127.0.0.1:PORT`. The CLI checks `CLOUDFLARED_TUNNEL` with
`cloudflared tunnel list`: it reuses an active connector, or securely obtains a
temporary credentials file and starts an inactive connector. A connector started by
the CLI is stopped after OAuth; an already-running connector is left alone.

## Usage

```sh
# Stop when the newest existing backup is reached
threads-backup

# Skip completed posts and continue an interrupted backup
threads-backup --resume

# Re-fetch every post and attached media
threads-backup --full-backup

# Save backups in another folder
threads-backup --backup-folder ./archive

threads-backup --help
threads-backup --version
```

The default mode is incremental: posts are returned newest first, and the CLI
stops when it reaches the first post whose JSON file already exists.
`--resume` scans all pages, skips posts whose JSON file exists, and backs up
missing posts left by an interrupted run.
`--full-backup` overwrites files returned by the API but does not delete unknown
files from an existing backup directory.

## Debug logging

Enable detailed post and media download logs with `NODE_DEBUG=threads-backup`:

```sh
NODE_DEBUG=threads-backup threads-backup
```

## Output

Post timestamps are converted to UTC:

```text
backups/
└── 2023/
    └── 2023-07-06-04-35-02-17977704596464643/
        ├── 17977704596464643.json
        ├── 17977704596464643-media.jpg
        ├── 17977704596464643-thumbnail.jpg
        └── 17977704596464644-media.mp4
```

Each JSON file contains:

```json
{
  "id": "17977704596464643",
  "timestamp": "2023-07-06T04:35:02+0000"
}
```

Media attached directly to the post and its carousel children is downloaded.
Media belonging to quoted or reposted third-party posts is not downloaded.

## Security and API access

- `.credentials/` uses `0700`; each `{username}.json` uses owner-only `0600`.
- Access tokens and app secrets are never included in operational logs or API
  query strings.
- The OAuth callback uses a cryptographically random `state` value.
- Do not commit `.env` or `.credentials/`.
- Quick Tunnels expose the callback server publicly only during authorization;
  the CLI stops the child process afterward.

`threads_basic` is the only requested permission. App testers can use the app
while it is in development mode. Allowing arbitrary users to authenticate can
require switching the Meta app live and completing the applicable Meta App
Review and data-handling requirements.

## Development

```sh
pnpm check
pnpm test
pnpm build
node dist/cli.js --help
```

Runtime code has no third-party dependencies. Tests use the Node.js test runner.

## License

MIT
