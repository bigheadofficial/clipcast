// YouTube Data API v3: OAuth (desktop loopback + PKCE) and resumable uploads.
import crypto from "node:crypto";
import { getTokens, saveTokens, clearTokens, createJob, updateJob } from "./store.js";
import { startLoopback, openBrowser, randomString, fetchRetry, readChunk, checkFile, VIDEO_TYPES, IMAGE_TYPES, sleep } from "./util.js";

const AUTH_URL = process.env.CLIPCAST_GOOGLE_AUTH_URL || "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = process.env.CLIPCAST_GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";
const API = process.env.CLIPCAST_YT_API || "https://www.googleapis.com/youtube/v3";
const UPLOAD_API = process.env.CLIPCAST_YT_UPLOAD_API || "https://www.googleapis.com/upload/youtube/v3";
const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];
const CHUNK = 8 * 1024 * 1024; // must be a multiple of 256 KiB

function creds() {
  const id = process.env.GOOGLE_CLIENT_ID?.trim();
  const secret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!id || !secret) {
    throw new Error(
      "YouTube isn't set up yet: add your Google OAuth Client ID and Client Secret in the ClipCast connector settings (see SETUP guide, part A)."
    );
  }
  return { id, secret };
}

export function youtubeConfigured() {
  return Boolean(process.env.GOOGLE_CLIENT_ID?.trim() && process.env.GOOGLE_CLIENT_SECRET?.trim());
}

// ---------------- auth ----------------
export async function startYouTubeLogin() {
  const { id, secret } = creds();
  const verifier = randomString(64);
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  const state = randomString(24);

  const { redirectUri } = await startLoopback({
    platform: "youtube",
    callbackPath: "/",
    onCode: async (q) => {
      if (q.error) throw new Error(`Google said: ${q.error}`);
      if (q.state !== state) throw new Error("Security check failed (state mismatch). Try connecting again.");
      const res = await fetch(TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: q.code,
          client_id: id,
          client_secret: secret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
          code_verifier: verifier,
        }),
      });
      const t = await res.json();
      if (!res.ok) throw new Error(`Token exchange failed: ${t.error_description || t.error || res.status}`);
      saveTokens("youtube", {
        access_token: t.access_token,
        refresh_token: t.refresh_token,
        expires_at: Date.now() + (t.expires_in - 60) * 1000,
        scope: t.scope,
      });
      const ch = await getChannel().catch(() => null);
      if (ch) saveTokens("youtube", { channel_title: ch.title, channel_id: ch.id });
      return ch ? `YouTube channel "${ch.title}" is connected` : "YouTube is connected";
    },
  });

  const url =
    AUTH_URL +
    "?" +
    new URLSearchParams({
      client_id: id,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
  const opened = openBrowser(url);
  return { url, opened };
}

async function accessToken() {
  const t = getTokens("youtube");
  if (!t?.refresh_token && !t?.access_token) {
    throw new Error("YouTube isn't connected. Use the connect_youtube tool first.");
  }
  if (t.access_token && t.expires_at > Date.now()) return t.access_token;
  const { id, secret } = creds();
  const res = await fetchRetry(
    TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: t.refresh_token, grant_type: "refresh_token" }),
    },
    { label: "Google token refresh" }
  );
  const j = await res.json();
  if (!res.ok) {
    if (j.error === "invalid_grant") {
      clearTokens("youtube");
      throw new Error(
        "YouTube login has expired or was revoked (Google expires logins after 7 days while your Google Cloud app is in 'Testing'). Run connect_youtube again."
      );
    }
    throw new Error(`Google token refresh failed: ${j.error_description || j.error}`);
  }
  saveTokens("youtube", { access_token: j.access_token, expires_at: Date.now() + (j.expires_in - 60) * 1000 });
  return j.access_token;
}

async function api(path, opts = {}) {
  const token = await accessToken();
  const res = await fetchRetry(API + path, { ...opts, headers: { Authorization: `Bearer ${token}`, ...(opts.headers || {}) } }, { label: "YouTube API" });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`YouTube API error: ${j.error?.message || res.status}`);
  return j;
}

export async function getChannel() {
  const j = await api("/channels?part=snippet,contentDetails,statistics&mine=true");
  const c = j.items?.[0];
  if (!c) throw new Error("This Google account has no YouTube channel. Create one at youtube.com first.");
  return {
    id: c.id,
    title: c.snippet.title,
    subscribers: c.statistics?.subscriberCount,
    videos: c.statistics?.videoCount,
    uploads_playlist: c.contentDetails?.relatedPlaylists?.uploads,
  };
}

export async function listMyVideos(limit = 10) {
  const ch = await getChannel();
  const j = await api(`/playlistItems?part=snippet,status&maxResults=${Math.min(50, limit)}&playlistId=${ch.uploads_playlist}`);
  return (j.items || []).map((i) => ({
    title: i.snippet.title,
    video_id: i.snippet.resourceId.videoId,
    url: `https://youtu.be/${i.snippet.resourceId.videoId}`,
    published: i.snippet.publishedAt,
    privacy: i.status?.privacyStatus,
  }));
}

// ---------------- upload ----------------
export function startYouTubeUpload(opts) {
  const v = checkFile(opts.file_path, VIDEO_TYPES);
  if (opts.thumbnail_path) checkFile(opts.thumbnail_path, IMAGE_TYPES);
  if (opts.publish_at && opts.privacy !== "private") {
    // YouTube requires private status for scheduled publishing.
    opts.privacy = "private";
  }
  const job = createJob("youtube", v.file, { size: v.size, title: opts.title });
  runUpload(job.id, v, opts).catch((e) => updateJob(job.id, { state: "failed", error: String(e.message || e) }));
  return job;
}

async function runUpload(jobId, v, o) {
  const token = await accessToken();
  const metadata = {
    snippet: {
      title: o.title.slice(0, 100),
      description: (o.description || "").slice(0, 5000),
      tags: o.tags || [],
      categoryId: String(o.category_id || "22"),
      ...(o.language ? { defaultLanguage: o.language, defaultAudioLanguage: o.language } : {}),
    },
    status: {
      privacyStatus: o.privacy || "private",
      selfDeclaredMadeForKids: Boolean(o.made_for_kids),
      ...(o.publish_at ? { publishAt: new Date(o.publish_at).toISOString() } : {}),
      ...(o.contains_synthetic_media !== undefined ? { containsSyntheticMedia: Boolean(o.contains_synthetic_media) } : {}),
    },
  };

  updateJob(jobId, { state: "uploading" });
  const init = await fetchRetry(
    `${UPLOAD_API}/videos?uploadType=resumable&part=snippet,status&notifySubscribers=${o.notify_subscribers === false ? "false" : "true"}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": String(v.size),
        "X-Upload-Content-Type": v.mime,
      },
      body: JSON.stringify(metadata),
    },
    { label: "YouTube upload start" }
  );
  if (!init.ok) {
    const j = await init.json().catch(() => ({}));
    const reason = j.error?.errors?.[0]?.reason;
    if (reason === "quotaExceeded") throw new Error("YouTube daily API quota used up (about 6 uploads/day on the free quota). Try again tomorrow or request more quota.");
    if (reason === "uploadLimitExceeded") throw new Error("This channel hit YouTube's upload limit for now. Try later.");
    throw new Error(`YouTube refused the upload: ${j.error?.message || init.status}`);
  }
  const session = init.headers.get("location");
  if (!session) throw new Error("YouTube did not return an upload session URL.");

  let start = 0;
  let video = null;
  let failures = 0;
  while (!video) {
    const end = Math.min(start + CHUNK, v.size) - 1;
    const body = await readChunk(v.file, start, end - start + 1);
    let res;
    try {
      res = await fetch(session, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${await accessToken()}`,
          "Content-Length": String(body.length),
          "Content-Range": `bytes ${start}-${end}/${v.size}`,
          "Content-Type": v.mime,
        },
        body,
      });
    } catch (e) {
      res = null;
    }

    if (res && (res.status === 200 || res.status === 201)) {
      video = await res.json();
      break;
    }
    if (res && res.status === 308) {
      failures = 0;
      const range = res.headers.get("range");
      start = range ? Number(range.split("-")[1]) + 1 : 0;
      updateJob(jobId, { progress: Math.round((start / v.size) * 100) });
      continue;
    }
    if (res && res.status >= 400 && res.status < 500 && res.status !== 408) {
      const j = await res.json().catch(() => ({}));
      throw new Error(`YouTube upload failed: ${j.error?.message || res.status}`);
    }
    // Network error or 5xx: ask YouTube how much it has, then resume.
    if (++failures > 8) throw new Error("YouTube upload kept failing (network problem). Try again.");
    await sleep(Math.min(30000, 1000 * 2 ** failures));
    const probe = await fetch(session, {
      method: "PUT",
      headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Length": "0", "Content-Range": `bytes */${v.size}` },
    }).catch(() => null);
    if (probe && (probe.status === 200 || probe.status === 201)) {
      video = await probe.json();
      break;
    }
    if (probe && probe.status === 308) {
      const range = probe.headers.get("range");
      start = range ? Number(range.split("-")[1]) + 1 : 0;
    }
  }

  const result = {
    state: "done",
    progress: 100,
    video_id: video.id,
    url: `https://youtu.be/${video.id}`,
    studio_url: `https://studio.youtube.com/video/${video.id}/edit`,
    privacy: video.status?.privacyStatus,
    publish_at: video.status?.publishAt,
  };

  if (o.thumbnail_path) {
    try {
      const img = checkFile(o.thumbnail_path, IMAGE_TYPES);
      const data = await readChunk(img.file, 0, img.size);
      const r = await fetchRetry(`${UPLOAD_API}/thumbnails/set?videoId=${video.id}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": img.mime },
        body: data,
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        result.thumbnail_warning = `Video uploaded, but the thumbnail was rejected: ${j.error?.message || r.status}. (Custom thumbnails need a phone-verified channel and an image under 2 MB.)`;
      } else result.thumbnail = "set";
    } catch (e) {
      result.thumbnail_warning = `Video uploaded, but thumbnail failed: ${e.message}`;
    }
  }
  updateJob(jobId, result);
}
