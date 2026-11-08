// TikTok Content Posting API: Login Kit for Desktop (PKCE, hex SHA256) + direct post / inbox upload.
import crypto from "node:crypto";
import { getTokens, saveTokens, clearTokens, createJob, updateJob, getJob } from "./store.js";
import { startLoopback, openBrowser, randomString, fetchRetry, readChunk, checkFile, sleep } from "./util.js";

const AUTH_URL = process.env.CLIPCAST_TT_AUTH_URL || "https://www.tiktok.com/v2/auth/authorize/";
const API = process.env.CLIPCAST_TT_API || "https://open.tiktokapis.com/v2";
const MB = 1024 * 1024;

// TikTok only accepts these containers.
export const TIKTOK_VIDEO_TYPES = { ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm" };

function creds() {
  const key = process.env.TIKTOK_CLIENT_KEY?.trim();
  const secret = process.env.TIKTOK_CLIENT_SECRET?.trim();
  if (!key || !secret) {
    throw new Error(
      "TikTok isn't set up yet: add your TikTok Client Key and Client Secret in the ClipCast connector settings (see SETUP guide, part B)."
    );
  }
  return { key, secret };
}

export function tiktokConfigured() {
  return Boolean(process.env.TIKTOK_CLIENT_KEY?.trim() && process.env.TIKTOK_CLIENT_SECRET?.trim());
}

const scopes = () => (process.env.TIKTOK_SCOPES?.trim() || "user.info.basic,video.publish,video.upload").replace(/\s+/g, "");

async function tokenRequest(params) {
  const res = await fetchRetry(
    `${API}/oauth/token/`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-cache" },
      body: new URLSearchParams(params),
    },
    { label: "TikTok token" }
  );
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) {
    const err = new Error(j.error_description || j.error || `HTTP ${res.status}`);
    err.code = j.error;
    throw err;
  }
  return j;
}

function storeTokenResponse(t) {
  saveTokens("tiktok", {
    access_token: t.access_token,
    refresh_token: t.refresh_token,
    open_id: t.open_id,
    scope: t.scope,
    expires_at: Date.now() + (t.expires_in - 120) * 1000,
    refresh_expires_at: Date.now() + (t.refresh_expires_in || 0) * 1000,
  });
}

// ---------------- auth ----------------
export async function startTikTokLogin() {
  const { key, secret } = creds();
  const verifier = randomString(64);
  const challenge = crypto.createHash("sha256").update(verifier).digest("hex"); // TikTok desktop wants HEX, not base64url
  const state = randomString(24);
  const port = Number(process.env.TIKTOK_REDIRECT_PORT) || 0;

  const { redirectUri } = await startLoopback({
    platform: "tiktok",
    port,
    callbackPath: "/callback/",
    onCode: async (q) => {
      if (q.error) throw new Error(`TikTok said: ${q.error_description || q.error}`);
      if (q.state !== state) throw new Error("Security check failed (state mismatch). Try connecting again.");
      const t = await tokenRequest({
        client_key: key,
        client_secret: secret,
        code: q.code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code_verifier: verifier,
      });
      storeTokenResponse(t);
      const info = await getCreatorInfo().catch(() => null);
      if (info) saveTokens("tiktok", { username: info.creator_username, nickname: info.creator_nickname });
      return info ? `TikTok account @${info.creator_username} is connected` : "TikTok is connected";
    },
  });

  const url =
    AUTH_URL +
    "?" +
    new URLSearchParams({
      client_key: key,
      response_type: "code",
      scope: scopes(),
      redirect_uri: redirectUri,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
  const opened = openBrowser(url);
  return { url, opened, redirectUri };
}

async function accessToken() {
  const t = getTokens("tiktok");
  if (!t?.refresh_token) throw new Error("TikTok isn't connected. Use the connect_tiktok tool first.");
  if (t.access_token && t.expires_at > Date.now()) return t.access_token;
  const { key, secret } = creds();
  try {
    const j = await tokenRequest({ client_key: key, client_secret: secret, grant_type: "refresh_token", refresh_token: t.refresh_token });
    storeTokenResponse(j); // TikTok rotates the refresh token, so always save the new one
    return j.access_token;
  } catch (e) {
    if (e.code === "invalid_grant") {
      clearTokens("tiktok");
      throw new Error("TikTok login has expired or was revoked. Run connect_tiktok again.");
    }
    throw e;
  }
}

async function api(path, body) {
  const res = await fetchRetry(
    API + path,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json; charset=UTF-8" },
      body: JSON.stringify(body || {}),
    },
    { label: "TikTok API" }
  );
  const j = await res.json().catch(() => ({}));
  if (j.error && j.error.code && j.error.code !== "ok") throw new Error(explain(j.error));
  if (!res.ok) throw new Error(`TikTok API error: HTTP ${res.status}`);
  return j.data;
}

function explain(err) {
  const tips = {
    unaudited_client_can_only_post_to_private_accounts:
      "Your TikTok app hasn't passed TikTok's audit yet, so it can only post to a PRIVATE TikTok account with privacy SELF_ONLY. Set your TikTok account to private for testing, or use mode 'draft' — or apply for the audit in the TikTok developer portal.",
    spam_risk_too_many_posts: "TikTok's daily API post limit for this account has been reached. Try again tomorrow.",
    spam_risk_too_many_pending_share: "Too many drafts are waiting in your TikTok inbox (max 5 per 24h). Open TikTok and post or delete them first.",
    spam_risk_user_banned_from_posting: "TikTok has blocked this account from posting right now.",
    privacy_level_option_mismatch: "That privacy level isn't allowed for this account. Call tiktok_account_info to see the allowed options.",
    scope_not_authorized: "The TikTok login is missing a permission (video.publish or video.upload). Make sure the scope is enabled for your app in the TikTok portal, then run connect_tiktok again.",
    access_token_invalid: "TikTok login is invalid. Run connect_tiktok again.",
    rate_limit_exceeded: "TikTok rate limit hit. Wait a minute and try again.",
  };
  return tips[err.code] || `TikTok error (${err.code}): ${err.message || ""}`.trim();
}

export async function getCreatorInfo() {
  return api("/post/publish/creator_info/query/");
}

export async function fetchPostStatus(publishId) {
  return api("/post/publish/status/fetch/", { publish_id: publishId });
}

/** Pick chunk sizes that follow TikTok's rules (5–64 MB chunks, last chunk ≤128 MB, ≤1000 chunks). */
export function planChunks(size) {
  if (size <= 64 * MB) return { chunk_size: size, total_chunk_count: 1 };
  const chunk = 10 * MB;
  return { chunk_size: chunk, total_chunk_count: Math.floor(size / chunk) };
}

// ---------------- upload ----------------
export async function startTikTokUpload(o) {
  const v = checkFile(o.file_path, TIKTOK_VIDEO_TYPES);
  const mode = o.mode || "direct";
  if (v.size > 4 * 1024 * MB) throw new Error("TikTok accepts videos up to 4 GB.");

  let postInfo = null;
  if (mode === "direct") {
    // TikTok requires checking creator info right before posting.
    const info = await getCreatorInfo();
    const allowed = info.privacy_level_options || [];
    const privacy = o.privacy || (allowed.includes("SELF_ONLY") ? "SELF_ONLY" : allowed[0]);
    if (!allowed.includes(privacy)) {
      throw new Error(`Privacy "${privacy}" isn't available for @${info.creator_username}. Allowed: ${allowed.join(", ")}`);
    }
    postInfo = {
      title: (o.caption || "").slice(0, 2200),
      privacy_level: privacy,
      disable_comment: Boolean(o.disable_comment || info.comment_disabled),
      disable_duet: Boolean(o.disable_duet || info.duet_disabled),
      disable_stitch: Boolean(o.disable_stitch || info.stitch_disabled),
      video_cover_timestamp_ms: o.cover_timestamp_ms ?? 1000,
      brand_content_toggle: Boolean(o.branded_content),
      brand_organic_toggle: Boolean(o.promoting_own_business),
      ...(o.is_ai_generated ? { is_aigc: true } : {}),
    };
  }

  const plan = planChunks(v.size);
  const body = { source_info: { source: "FILE_UPLOAD", video_size: v.size, ...plan } };
  if (postInfo) body.post_info = postInfo;
  const init = await api(mode === "direct" ? "/post/publish/video/init/" : "/post/publish/inbox/video/init/", body);

  const job = createJob("tiktok", v.file, {
    size: v.size,
    mode,
    caption: o.caption,
    privacy: postInfo?.privacy_level,
    publish_id: init.publish_id,
  });
  runUpload(job.id, v, plan, init.upload_url).catch((e) => updateJob(job.id, { state: "failed", error: String(e.message || e) }));
  return job;
}

async function runUpload(jobId, v, plan, uploadUrl) {
  updateJob(jobId, { state: "uploading" });
  const { chunk_size, total_chunk_count } = plan;
  for (let i = 0; i < total_chunk_count; i++) {
    const start = i * chunk_size;
    const end = i === total_chunk_count - 1 ? v.size - 1 : start + chunk_size - 1; // last chunk absorbs the remainder
    const data = await readChunk(v.file, start, end - start + 1);
    const res = await fetchRetry(
      uploadUrl,
      {
        method: "PUT",
        headers: {
          "Content-Type": v.mime,
          "Content-Length": String(data.length),
          "Content-Range": `bytes ${start}-${end}/${v.size}`,
        },
        body: data,
      },
      { label: "TikTok chunk upload" }
    );
    if (res.status !== 201 && res.status !== 206) {
      const t = await res.text().catch(() => "");
      if (res.status === 403) throw new Error("TikTok's upload link expired (they last ~1 hour). Start the upload again.");
      throw new Error(`TikTok chunk ${i + 1}/${total_chunk_count} failed: HTTP ${res.status} ${t}`);
    }
    updateJob(jobId, { progress: Math.round(((end + 1) / v.size) * 100) });
  }
  updateJob(jobId, { state: "processing", progress: 100 });

  // Poll TikTok until it finishes processing (up to ~5 minutes).
  const job = getJob(jobId);
  for (let i = 0; i < 60; i++) {
    await sleep(5000);
    const s = await fetchPostStatus(job.publish_id).catch(() => null);
    if (!s) continue;
    if (s.status === "FAILED") throw new Error(`TikTok couldn't process the video: ${s.fail_reason || "unknown reason"}`);
    if (s.status === "SEND_TO_USER_INBOX") {
      updateJob(jobId, { state: "done", tiktok_status: s.status, note: "Sent to your TikTok inbox. Open the TikTok app, tap the notification, edit and post." });
      return;
    }
    if (s.status === "PUBLISH_COMPLETE") {
      const ids = s.publicaly_available_post_id || s.publicly_available_post_id || [];
      const t = getTokens("tiktok");
      updateJob(jobId, {
        state: "done",
        tiktok_status: s.status,
        post_id: ids[0],
        url: ids[0] && t?.username ? `https://www.tiktok.com/@${t.username}/video/${ids[0]}` : undefined,
        note: ids[0] ? undefined : "Posted. (Private/SELF_ONLY posts have no public link — check your TikTok profile.)",
      });
      return;
    }
    updateJob(jobId, { tiktok_status: s.status });
  }
  updateJob(jobId, { state: "processing", note: "Uploaded; TikTok is still processing. Check upload_status again in a few minutes." });
}
