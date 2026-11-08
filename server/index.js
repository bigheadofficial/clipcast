#!/usr/bin/env node
// ClipCast — a Claude connector (MCP server) that uploads videos to YouTube and TikTok.
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DATA_DIR, getTokens, clearTokens, getJob, listJobs, updateJob } from "./store.js";
import { VIDEO_TYPES, cleanPath, formatBytes, sleep } from "./util.js";
import { startYouTubeLogin, startYouTubeUpload, youtubeConfigured, getChannel, listMyVideos } from "./youtube.js";
import { startTikTokLogin, startTikTokUpload, tiktokConfigured, getCreatorInfo, fetchPostStatus } from "./tiktok.js";

// Blank optional settings can arrive as the literal "${user_config.x}" placeholder — treat as empty.
for (const k of ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET", "TIKTOK_SCOPES"]) {
  if (process.env[k]?.includes("${")) delete process.env[k];
}

const server = new McpServer({ name: "clipcast", version: "1.0.0" });

const text = (obj) => ({ content: [{ type: "text", text: typeof obj === "string" ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ content: [{ type: "text", text: `Error: ${e?.message || e}` }], isError: true });
const safe = (fn) => async (args) => {
  try {
    return await fn(args || {});
  } catch (e) {
    return fail(e);
  }
};

function describeJob(j) {
  if (!j) return null;
  const out = {
    job_id: j.id,
    platform: j.platform,
    file: path.basename(j.file),
    size: j.size ? formatBytes(j.size) : undefined,
    state: j.state,
    progress: `${j.progress || 0}%`,
  };
  for (const k of ["title", "caption", "mode", "privacy", "url", "studio_url", "video_id", "post_id", "publish_at", "tiktok_status", "thumbnail", "thumbnail_warning", "note", "error"]) {
    if (j[k] !== undefined && j[k] !== null && j[k] !== "") out[k] = j[k];
  }
  return out;
}

/** Wait a little so short uploads can report "done" in the same tool call. */
async function waitForJob(id, ms = 25000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const j = getJob(id);
    if (!j || ["done", "failed"].includes(j.state)) break;
    await sleep(1000);
  }
  return getJob(id);
}

// ---------------- status & accounts ----------------
server.registerTool(
  "clipcast_status",
  {
    title: "ClipCast status",
    description: "Show which accounts (YouTube, TikTok) are set up and connected, plus recent uploads. Call this first if unsure.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  safe(async () => {
    const yt = getTokens("youtube");
    const tt = getTokens("tiktok");
    return text({
      youtube: !youtubeConfigured()
        ? "Not set up — Google Client ID/Secret missing in connector settings"
        : yt
        ? `Connected${yt.channel_title ? ` — channel "${yt.channel_title}"` : ""}`
        : "Set up but not connected — call connect_youtube",
      tiktok: !tiktokConfigured()
        ? "Not set up — TikTok Client Key/Secret missing in connector settings"
        : tt
        ? `Connected${tt.username ? ` — @${tt.username}` : ""}`
        : "Set up but not connected — call connect_tiktok",
      recent_uploads: listJobs(5).map(describeJob),
      data_folder: DATA_DIR,
    });
  })
);

server.registerTool(
  "connect_youtube",
  {
    title: "Connect YouTube",
    description:
      "Open the Google sign-in page in the user's browser to connect their YouTube channel. Returns immediately; the user approves in the browser, then call clipcast_status to confirm.",
    inputSchema: {},
  },
  safe(async () => {
    const { url, opened } = await startYouTubeLogin();
    return text(
      `${opened ? "I opened Google sign-in in your browser." : "Open this link in your browser:"}\n${url}\n\n` +
        "Pick your YouTube channel's Google account and click Allow. If you see 'Google hasn't verified this app', click Advanced → Go to (your app). " +
        "When the browser says Connected, tell Claude — it can check with clipcast_status. The link works for 10 minutes."
    );
  })
);

server.registerTool(
  "connect_tiktok",
  {
    title: "Connect TikTok",
    description:
      "Open the TikTok sign-in page in the user's browser to connect their TikTok account. Returns immediately; the user approves in the browser, then call clipcast_status to confirm.",
    inputSchema: {},
  },
  safe(async () => {
    const { url, opened } = await startTikTokLogin();
    return text(
      `${opened ? "I opened TikTok sign-in in your browser." : "Open this link in your browser:"}\n${url}\n\n` +
        "Log in and tap Authorize. When the browser says Connected, tell Claude — it can check with clipcast_status. The link works for 10 minutes."
    );
  })
);

server.registerTool(
  "disconnect_account",
  {
    title: "Disconnect account",
    description: "Log out of YouTube or TikTok in ClipCast (deletes the saved login on this computer).",
    inputSchema: { platform: z.enum(["youtube", "tiktok"]) },
    annotations: { destructiveHint: true },
  },
  safe(async ({ platform }) => {
    clearTokens(platform);
    return text(`${platform} disconnected.`);
  })
);

// ---------------- files ----------------
server.registerTool(
  "find_videos",
  {
    title: "Find videos in a folder",
    description:
      "List video files in a folder on this computer (newest first) so you can pick one to upload. Example folder: C:\\Users\\Me\\Videos or ~/Videos.",
    inputSchema: {
      folder: z.string().describe("Folder path"),
      include_subfolders: z.boolean().optional().describe("Also search subfolders (default false)"),
      limit: z.number().int().min(1).max(200).optional(),
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ folder, include_subfolders, limit = 30 }) => {
    const root = cleanPath(folder);
    const found = [];
    const walk = (dir, depth) => {
      let entries = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory() && include_subfolders && depth < 4 && !e.name.startsWith(".")) walk(full, depth + 1);
        else if (e.isFile() && VIDEO_TYPES[path.extname(e.name).toLowerCase()]) {
          try {
            const st = fs.statSync(full);
            found.push({ path: full, size: formatBytes(st.size), modified: st.mtime.toISOString().slice(0, 16).replace("T", " ") , _t: st.mtimeMs });
          } catch {}
        }
      }
    };
    if (!fs.existsSync(root)) throw new Error(`Folder not found: ${root}`);
    walk(root, 0);
    found.sort((a, b) => b._t - a._t);
    return text(found.length ? found.slice(0, limit).map(({ _t, ...r }) => r) : `No video files found in ${root}`);
  })
);

// ---------------- YouTube ----------------
server.registerTool(
  "youtube_upload",
  {
    title: "Upload video to YouTube",
    description:
      "Upload a video file from this computer to the connected YouTube channel. Runs in the background; returns a job_id (use upload_status). " +
      "Vertical videos up to 3 minutes become Shorts automatically. Confirm title, description and privacy with the user before uploading. " +
      "Note: until the user's Google Cloud project passes YouTube's API audit, YouTube forces uploads to private.",
    inputSchema: {
      file_path: z.string().describe("Full path to the video file"),
      title: z.string().min(1).max(100),
      description: z.string().max(5000).optional(),
      tags: z.array(z.string()).optional(),
      privacy: z.enum(["private", "unlisted", "public"]).optional().describe("Default private"),
      publish_at: z.string().optional().describe("Schedule: ISO date-time e.g. 2026-11-10T18:00:00+05:00 (video stays private until then)"),
      category_id: z.string().optional().describe("YouTube category id. 22 People & Blogs (default), 24 Entertainment, 27 Education, 28 Science & Tech, 10 Music, 20 Gaming, 17 Sports, 26 Howto & Style, 15 Pets & Animals, 19 Travel"),
      made_for_kids: z.boolean().optional().describe("Default false"),
      thumbnail_path: z.string().optional().describe("Optional JPG/PNG thumbnail (≤2 MB, channel must be phone-verified)"),
      language: z.string().optional().describe("e.g. en, ur, hi"),
      contains_synthetic_media: z.boolean().optional().describe("True if realistic AI-generated/altered content"),
      notify_subscribers: z.boolean().optional(),
    },
  },
  safe(async (args) => {
    const job = startYouTubeUpload(args);
    return text(describeJob(await waitForJob(job.id)));
  })
);

server.registerTool(
  "youtube_my_videos",
  {
    title: "List my YouTube videos",
    description: "Show the connected YouTube channel and its most recent uploads.",
    inputSchema: { limit: z.number().int().min(1).max(50).optional() },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ limit = 10 }) => text({ channel: await getChannel(), videos: await listMyVideos(limit) }))
);

// ---------------- TikTok ----------------
server.registerTool(
  "tiktok_account_info",
  {
    title: "TikTok account & posting options",
    description:
      "Get the connected TikTok account's name, allowed privacy levels, max video length and whether comments/duet/stitch are disabled. Call this before tiktok_upload and show the privacy options to the user.",
    inputSchema: {},
    annotations: { readOnlyHint: true },
  },
  safe(async () => text(await getCreatorInfo()))
);

server.registerTool(
  "tiktok_upload",
  {
    title: "Upload video to TikTok",
    description:
      "Upload an MP4/MOV/WebM video from this computer to TikTok. mode 'direct' posts it to the profile; mode 'draft' sends it to the user's TikTok inbox to finish editing in the app. " +
      "TikTok rules: get explicit user consent and let them choose the privacy level (from tiktok_account_info) — never pick PUBLIC on your own. " +
      "Until the TikTok app passes TikTok's audit, direct posts only work with privacy SELF_ONLY on a private account. Runs in the background; returns a job_id.",
    inputSchema: {
      file_path: z.string().describe("Full path to the video file (.mp4, .mov or .webm)"),
      mode: z.enum(["direct", "draft"]).optional().describe("direct = publish now (default); draft = send to TikTok inbox"),
      caption: z.string().max(2200).optional().describe("Caption with #hashtags and @mentions (direct mode)"),
      privacy: z
        .enum(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"])
        .optional()
        .describe("Must be one of the account's allowed options. Default SELF_ONLY"),
      disable_comment: z.boolean().optional(),
      disable_duet: z.boolean().optional(),
      disable_stitch: z.boolean().optional(),
      cover_timestamp_ms: z.number().int().min(0).optional().describe("Which frame (ms) to use as cover"),
      branded_content: z.boolean().optional().describe("Paid partnership / promoting a third-party brand"),
      promoting_own_business: z.boolean().optional().describe("Promoting the creator's own business"),
      is_ai_generated: z.boolean().optional().describe("Label as AI-generated content"),
    },
  },
  safe(async (args) => {
    const job = await startTikTokUpload(args);
    return text(describeJob(await waitForJob(job.id)));
  })
);

// ---------------- jobs ----------------
server.registerTool(
  "upload_status",
  {
    title: "Upload status",
    description: "Check progress of an upload by job_id, or list recent uploads if no job_id is given.",
    inputSchema: {
      job_id: z.string().optional(),
      wait_seconds: z.number().int().min(0).max(50).optional().describe("Wait up to this long for the upload to finish before answering"),
    },
    annotations: { readOnlyHint: true },
  },
  safe(async ({ job_id, wait_seconds = 0 }) => {
    if (!job_id) return text(listJobs(10).map(describeJob));
    let j = getJob(job_id);
    if (!j) throw new Error(`No upload with id ${job_id}`);
    if (wait_seconds) j = await waitForJob(job_id, wait_seconds * 1000);
    // TikTok jobs left "processing" — ask TikTok directly.
    if (j.platform === "tiktok" && j.state === "processing" && j.publish_id) {
      const s = await fetchPostStatus(j.publish_id).catch(() => null);
      if (s?.status === "PUBLISH_COMPLETE" || s?.status === "SEND_TO_USER_INBOX") updateJob(j.id, { state: "done", tiktok_status: s.status, note: undefined });
      else if (s?.status === "FAILED") updateJob(j.id, { state: "failed", error: s.fail_reason });
      else if (s) updateJob(j.id, { tiktok_status: s.status });
      j = getJob(job_id);
    }
    return text(describeJob(j));
  })
);

await server.connect(new StdioServerTransport());
console.error(`ClipCast running. Data folder: ${DATA_DIR}`);
