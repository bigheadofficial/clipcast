---
name: "clipcast-video-uploader"
description: "Use when the user wants to upload, post, schedule or check videos on YouTube or TikTok through the ClipCast connector, or needs help setting ClipCast up."
---

# ClipCast video uploader

ClipCast is a local Claude Desktop connector that uploads videos from the user's PC to YouTube and TikTok through the official APIs. Its tools:

| Tool | Use for |
|---|---|
| `clipcast_status` | Check which accounts are set up and connected, and see recent uploads. Call this first. |
| `connect_youtube` / `connect_tiktok` | Open the browser login (returns immediately) |
| `disconnect_account` | Remove a saved login |
| `find_videos` | List video files in a folder, newest first |
| `youtube_upload` | Upload or schedule a YouTube video |
| `youtube_my_videos` | Show the channel and its recent uploads |
| `tiktok_account_info` | Get the allowed privacy levels and posting limits (required before posting) |
| `tiktok_upload` | Direct post, or send to TikTok drafts |
| `upload_status` | Check progress (use `wait_seconds` up to 50) |

If none of these tools are available, ClipCast isn't installed or enabled. Tell the user to install `ClipCast.mcpb` in Claude Desktop under Settings â†’ Extensions, enable it, and start a new chat.

## Workflow for every upload

1. **Check accounts.** Call `clipcast_status`.
   - If it says "Not set up", the keys are missing. Point the user to the setup steps below.
   - If it says "Not connected", call the matching `connect_*` tool. Tell the user to approve in the browser and say "done", then call `clipcast_status` again to confirm.
2. **Find the file.** If the user gave a full path, use it. If they gave a folder or said "my latest video", call `find_videos` and pick the newest file, or ask when it's unclear. Never guess a path.
3. **Write the text.** Draft text for each platform:
   - **YouTube title:** up to 100 characters, keyword first, no clickbait.
   - **YouTube description:** 2â€“4 short lines, a call to action, relevant links the user has given (for example their website or app link), then 3â€“5 hashtags.
   - **YouTube tags:** 5â€“15.
   - **YouTube category:** pick a sensible `category_id`.
   - **TikTok caption:** a short hook, then 3â€“6 hashtags, under 2,200 characters.
   - **Language:** write in the language the user asks for.
4. **Confirm with the user before uploading.** Show one compact summary: file name, platform(s), title or caption, privacy, and schedule time. For TikTok, list the privacy options from `tiktok_account_info` and let the user choose. TikTok requires explicit user consent, so never choose PUBLIC_TO_EVERYONE on your own. Wait for a yes.
5. **Upload.** Call `youtube_upload` and/or `tiktok_upload`. They can run in parallel. Each returns a `job_id`. Small files may already show `done`.
6. **Follow up.** If a job isn't done, call `upload_status` with `job_id` and `wait_seconds: 45`. Repeat until it's done or failed. Large files can take several minutes, so tell the user to keep Claude Desktop open.
7. **Report.** Give the YouTube link and Studio link, and the TikTok post link. If the TikTok post is private, say "check your profile". Pass on any `thumbnail_warning` or `note`.

## YouTube rules

- **Default privacy is `private`.** Use `unlisted` or `public` only if the user asks.
- **Scheduling:** pass `publish_at` as ISO 8601 with the user's UTC offset (for example `2026-11-10T19:00:00+05:00` for UTC+5). The video stays private until that time. Confirm the time in the user's local time.
- **Shorts:** a vertical video of 3 minutes or less becomes a Short automatically. Adding `#Shorts` to the title or description is optional.
- **Thumbnail:** JPG or PNG, under 2 MB, and the channel must be phone-verified.
- **Made for kids:** set `made_for_kids: true` only for content aimed at children.
- **AI content:** set `contains_synthetic_media: true` for realistic AI-generated video.
- **Unaudited projects:** if the Google project hasn't passed YouTube's API audit, uploads are forced to private even when public is requested. Tell the user they can switch the video to public in YouTube Studio.
- **Quota:** about 6 uploads per day. On `quotaExceeded`, tell the user to try again tomorrow.

## TikTok rules

- **File types:** only `.mp4`, `.mov` or `.webm`, up to 4 GB. Duration must be within `max_video_post_duration_sec` from `tiktok_account_info`.
- **Always call `tiktok_account_info` first** and use only privacy levels from `privacy_level_options`.
- **Modes:**
  - `mode: "direct"` posts to the profile.
  - `mode: "draft"` sends the video to the TikTok inbox. Tell the user to open the TikTok app, tap the notification, and post it. TikTok allows at most 5 pending drafts per 24 hours.
- **Before TikTok's audit:** direct posts only work with `SELF_ONLY` on a private account. If you get the error about unaudited clients, explain this and offer draft mode.
- **Labels:** set `branded_content` for paid promotion of another brand, `promoting_own_business` when promoting the user's own shop or app, and `is_ai_generated` for AI content. Ask the user when unsure.
- **Interaction settings:** respect disabled comments, duets or stitches from the account info.

## Posting to both platforms

- **Different text per platform.** Write a separate title for YouTube and caption for TikTok rather than copying one into the other.
- **Wrong format for TikTok:** if the file is `.mkv`, `.avi` or similar, upload it to YouTube only. Tell the user TikTok needs MP4, MOV or WebM and suggest converting it.
- **One platform fails:** report the success and the failure separately. Never retry a successful upload, because that would post a duplicate.

## Errors

- **"login expired" or "revoked":** run the `connect_*` tool again. YouTube logins expire every 7 days while the Google app is in Testing mode; publishing the app in Google Auth Platform stops this.
- **"Interrupted":** the app was closed mid-upload. Offer to start that upload again.
- **`spam_risk_*` or rate limits:** explain the error and stop. Don't loop retries.
- **File not found:** call `find_videos` on the parent folder and ask the user which file they meant.

## Setup help (when keys are missing)

**YouTube:**
1. In Google Cloud Console, create a project.
2. Enable **YouTube Data API v3**.
3. In **Google Auth Platform**, choose **External** and add the user's Gmail as a test user.
4. Under **Clients**, create an OAuth client of type **Desktop app**.
5. Paste the Client ID and Secret into the ClipCast extension settings.

**TikTok:**
1. On developers.tiktok.com, create an app and tick the **Desktop** platform.
2. Add **Login Kit** with the redirect URI `http://127.0.0.1:*/callback/`.
3. Add the **Content Posting API** with **Direct Post** on, and the scopes `user.info.basic`, `video.publish` and `video.upload`.
4. The app needs Terms of Service and Privacy Policy URLs.
5. Submit the app for review, or use Sandbox mode with the user's account as a target user while waiting.
6. Paste the Client key and Secret into the ClipCast extension settings.

After saving the keys, the user should restart Claude Desktop or toggle the extension off and on, then run `connect_youtube` / `connect_tiktok`.

## Style

- **Language:** keep replies short and in simple English, or the user's language.
- **Your actions:** don't explain tool mechanics unless asked. Say what you did and what the user needs to do.