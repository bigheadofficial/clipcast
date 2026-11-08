# ClipCast — YouTube & TikTok uploader for Claude

ClipCast is a **Claude Desktop extension** (an MCP server) that lets Claude upload videos from your computer to **your own** YouTube channel and TikTok account, using the official YouTube Data API and TikTok Content Posting API.

Once it's set up, you just ask Claude:

> "Upload `D:\Videos\my-reel.mp4` to YouTube and TikTok. Write a catchy title and hashtags."

Claude finds the file, writes the text, asks you to confirm, then uploads it.

- **Your keys, your accounts.** Everyone creates their own free Google and TikTok developer apps. There is no shared server.
- **Logins stay on your PC**, in `%APPDATA%\ClipCast` on Windows or `~/Library/Application Support/ClipCast` on macOS.
- **Resumable uploads** that retry automatically if your connection drops.

---

## Contents

1. [Install](#1-install)
2. [YouTube keys](#2-youtube-keys-about-10-minutes)
3. [TikTok keys](#3-tiktok-keys-about-20-minutes)
4. [Put the keys into ClipCast](#4-put-the-keys-into-clipcast)
5. [Connect your accounts](#5-connect-your-accounts)
6. [Things you can ask Claude](#things-you-can-ask-claude)
7. [Troubleshooting](#troubleshooting)

You only need the platform you want. Skip the YouTube or TikTok part if you don't use it.

---

## 1. Install

**Option A: download the extension.** Download `ClipCast.mcpb` from the [Releases](../../releases) page.

**Option B: build it yourself.** You need Node.js 20 or later.

```bash
git clone https://github.com/bigheadofficial/clipcast.git
cd clipcast
npm install
npx @anthropic-ai/mcpb pack . ClipCast.mcpb
```

Then, in **Claude Desktop**:

1. Go to **Settings → Extensions**.
2. Drag `ClipCast.mcpb` onto the page, or use **Advanced settings → Install Extension…**.
3. Click **Install**. The settings form opens, and you'll fill it in during step 4.

> If your browser saved the file as `ClipCast.mcpb.zip`, rename it to `ClipCast.mcpb` first.

---

## 2. YouTube keys (about 10 minutes)

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and **create a project**, named "ClipCast" for example.
2. Open **APIs & Services → Library**, search for **YouTube Data API v3**, and click **Enable**.
3. Open **Google Auth Platform** and click **Get started**:
   - App name: ClipCast. Support email: your Gmail.
   - Audience: **External**.
   - Contact email: your Gmail. Then agree to the policy and click **Create**.
4. Go to **Audience → Test users → Add users** and add the Gmail address that owns your YouTube channel.
5. Go to **Clients → Create client**, set **Application type** to **Desktop app**, and click **Create**.
6. Copy the **Client ID**, which ends in `.apps.googleusercontent.com`, and the **Client secret**, which starts with `GOCSPX-`.
   **The secret is shown only once.** If you lose it, open the client and use **Add secret**.

**What to expect on YouTube:**
- **Uploads start as private** until your Google project passes the free YouTube API audit. Until then, switch videos to Public in YouTube Studio.
- **Logins expire every 7 days** while the app is in Testing mode. Click **Audience → Publish app** to stop that. You'll see an "unverified app" warning when you log in, which is fine for your own use.
- **About 6 uploads per day** on the free quota.

---

## 3. TikTok keys (about 20 minutes)

TikTok requires **Terms of Service** and **Privacy Policy** pages on a website **you can verify you own**. A claude.ai or Google Docs link won't pass. Free GitHub Pages works:

### 3a. Host your legal pages (free, with GitHub Pages)

1. Create a GitHub account if you don't have one.
2. Create a **public** repository named exactly `<your-username>.github.io`.
3. Copy [`legal-templates/terms.html`](legal-templates/terms.html) and [`legal-templates/privacy.html`](legal-templates/privacy.html) from this repo. Replace `[YOUR NAME / CHANNEL]`, `[YOUR EMAIL]` and `[DATE]`, then upload both files to that repository.
4. After a minute or two they're live at:
   - `https://<your-username>.github.io/terms.html`
   - `https://<your-username>.github.io/privacy.html`

### 3b. Create the TikTok app

1. Go to [developers.tiktok.com](https://developers.tiktok.com). Sign up for a developer account, which is separate from your normal TikTok login, then open **Manage apps → Connect an app**.
2. Click **URL properties → Verify properties → URL prefix** and enter `https://<your-username>.github.io/`.
   TikTok gives you a file like `tiktokXXXX.txt`. Upload it to your `.github.io` repo, wait a minute, then click **Verify**.
3. **Use Sandbox first.** New apps need a demo video before review, so switch to **Sandbox → Create Sandbox** and fill in:
   - App icon (1024×1024), name, category, description
   - Terms and Privacy URLs from step 3a
   - Platforms: **Desktop**, with Web/Desktop URL `https://<your-username>.github.io/`
4. **Products → Add products:** add **Login Kit** and **Content Posting API**.
   - Login Kit → Redirect URI → **Desktop**: `http://127.0.0.1:*/callback/`
   - Content Posting API: turn on **Direct Post**
5. Check that **Scopes** shows `user.info.basic`, `video.upload` and `video.publish`.
6. Click **Apply changes**.
7. Under **Sandbox settings → Target users**, click **Add account** and log in with the TikTok account you'll post to.
8. Copy the sandbox **Client key** and **Client secret** from **Credentials**.

**What to expect on TikTok:**
- **Before TikTok audits your app**, posts can only go out as **"Only me" (SELF_ONLY)**, and your TikTok account must be **private** while you test.
- **Draft mode** sends videos to your TikTok inbox to finish in the app. TikTok allows up to 5 waiting drafts per day.
- **To post publicly**, record a short screen video of ClipCast working, add it to the **Production** version, and **Submit for review**.
- **Allowed files:** MP4, MOV or WebM, up to 4 GB.

---

## 4. Put the keys into ClipCast

Go to **Claude Desktop → Settings → Extensions → ClipCast** and click **Configure**:

| Field | Value |
|---|---|
| Google OAuth Client ID (YouTube) | your Client ID (`….apps.googleusercontent.com`) |
| Google OAuth Client Secret (YouTube) | your Client secret (`GOCSPX-…`) |
| TikTok Client Key | your sandbox Client key |
| TikTok Client Secret | your sandbox Client secret |
| TikTok scopes (advanced) | leave empty |

Click **Save**, then **switch the extension off and on again** so it loads the new keys.

> Keep your secrets private. Never commit them to git or paste them in public chats.

---

## 5. Connect your accounts

Start a **new chat** in Claude Desktop and say:

1. **"Connect my YouTube"**. Your browser opens. Log in and click **Allow**. On the "Google hasn't verified this app" screen, click **Advanced → Go to ClipCast**.
2. **"Connect my TikTok"**. Log in and click **Authorize**.
3. **"ClipCast status"** to confirm that both accounts are connected.

---

## Things you can ask Claude

- "Show me the newest videos in `C:\Users\Me\Videos\Reels`."
- "Upload the newest one to YouTube as a Short. Write the title, add 5 tags, and keep it unlisted."
- "Schedule `promo.mp4` on YouTube for tomorrow at 7 pm my time."
- "Post `unboxing.mp4` to TikTok with a caption and hashtags, privacy Only me."
- "Send `reel.mp4` to my TikTok drafts."
- "Is my upload finished?" or "Show my last 10 YouTube videos."

### Optional: Claude skill

[`skill/clipcast-video-uploader/SKILL.md`](skill/clipcast-video-uploader/SKILL.md) teaches Claude the best workflow: check accounts, write platform-specific titles and captions, confirm before posting, and follow up on uploads. Add it as a skill in Claude for smoother results.

---

## Tools

| Tool | What it does |
|---|---|
| `clipcast_status` | Shows which accounts are connected, plus recent uploads |
| `connect_youtube` / `connect_tiktok` | Opens the browser login |
| `disconnect_account` | Removes a saved login |
| `find_videos` | Lists video files in a folder, newest first |
| `youtube_upload` | Uploads or schedules a video, with optional thumbnail, tags, category and made-for-kids setting |
| `youtube_my_videos` | Lists your channel's recent uploads |
| `tiktok_account_info` | Shows the privacy options and limits TikTok allows (required before posting) |
| `tiktok_upload` | Direct post or draft, with caption, privacy, interaction settings and AI/branded labels |
| `upload_status` | Shows upload progress |

Keep Claude Desktop open until an upload finishes.

---

## Troubleshooting

| Problem | Fix |
|---|---|
| Status says "Not set up" after saving keys | Switch the extension off and on, or start a new chat |
| "Google hasn't verified this app" | Click **Advanced → Go to ClipCast**. This is expected for your own app |
| YouTube login stopped working after a week | Reconnect, or **Publish app** in Google Auth Platform |
| `unaudited_client_can_only_post_to_private_accounts` | Set your TikTok account to private and use privacy SELF_ONLY, or wait for TikTok's audit |
| TikTok `redirect_uri` error | The Desktop redirect URI must be exactly `http://127.0.0.1:*/callback/` |
| TikTok "This URL is not verified" | Verify your `https://<username>.github.io/` URL prefix first (step 3b) |
| Extension won't start | Install Node.js 20 LTS from nodejs.org and restart Claude |

Saved logins are in `%APPDATA%\ClipCast\tokens.json`. Delete that file to log out of everything.

---

## Use without the .mcpb package

Add this to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "clipcast": {
      "command": "node",
      "args": ["/path/to/clipcast/server/index.js"],
      "env": {
        "GOOGLE_CLIENT_ID": "...",
        "GOOGLE_CLIENT_SECRET": "...",
        "TIKTOK_CLIENT_KEY": "...",
        "TIKTOK_CLIENT_SECRET": "..."
      }
    }
  }
}
```

## Code layout

- `server/index.js`: the MCP tool definitions
- `server/youtube.js`: Google OAuth and YouTube resumable uploads
- `server/tiktok.js`: TikTok Login Kit (PKCE) and the Content Posting API
- `server/store.js`: saved logins and upload jobs
- `server/util.js`: shared helpers
- `manifest.json`: the Claude Desktop extension manifest

## License

[MIT](LICENSE). ClipCast is not affiliated with, endorsed by or sponsored by Google, YouTube or TikTok.
