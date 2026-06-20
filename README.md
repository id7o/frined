# Friend

## Run

1. Install Node.js 18 or newer.
2. Open a terminal in this folder.
3. Run `npm start`.
4. Open `http://localhost:3000`.

## Discord administrator access

There is no site password. The authorized administrator signs in through Discord.

1. Create an application in the Discord Developer Portal.
2. In OAuth2, add this redirect URL: `http://localhost:3000/auth/discord/callback` (use the live site URL when publishing).
3. Enable Developer Mode in Discord, right-click the administrator account, and copy its User ID.
4. Start the site with the application credentials and administrator User ID:

```powershell
$env:DISCORD_CLIENT_ID="your-application-id"
$env:DISCORD_CLIENT_SECRET="your-client-secret"
$env:DISCORD_ADMIN_USER_ID="your-discord-user-id"
$env:PUBLIC_URL="http://localhost:3000"
npm start
```

Only that Discord account will receive the management controls. Videos are selected from the administrator's device and uploaded to the server.

Uploaded videos are stored in `uploads/`, and their public placement is stored in `data/clips.json`. Keep both folders when moving or backing up the site.

## Publish on Railway

1. Extract `friend-site.zip`.
2. Create a GitHub repository and upload everything **inside** the `friend-site` folder.
3. In Railway, choose **New Project → Deploy from GitHub Repo**, then select the repository.
4. Open **Settings → Networking → Generate Domain** and copy the HTTPS site URL.
5. Add a Railway Volume to the service and mount it at `/data`.
6. Add these Railway variables:

```text
STORAGE_DIR=/data
PUBLIC_URL=https://your-railway-domain.up.railway.app
DISCORD_CLIENT_ID=your-application-id
DISCORD_CLIENT_SECRET=your-client-secret
DISCORD_ADMIN_USER_ID=your-discord-user-id
```

7. In the Discord Developer Portal, add this OAuth2 redirect, replacing the example domain with the real Railway domain:

```text
https://your-railway-domain.up.railway.app/auth/discord/callback
```

Railway will run `npm start` automatically. The volume keeps uploaded videos when the service restarts or redeploys.
