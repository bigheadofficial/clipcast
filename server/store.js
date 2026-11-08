// Local storage for tokens and upload jobs.
// Windows: %APPDATA%\ClipCast   macOS/Linux: ~/.clipcast
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DATA_DIR =
  process.env.CLIPCAST_DATA_DIR ||
  (process.platform === "win32" && process.env.APPDATA
    ? path.join(process.env.APPDATA, "ClipCast")
    : path.join(os.homedir(), ".clipcast"));

fs.mkdirSync(DATA_DIR, { recursive: true });

const TOKENS_FILE = path.join(DATA_DIR, "tokens.json");
const JOBS_FILE = path.join(DATA_DIR, "jobs.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ---------- tokens ----------
export function getTokens(platform) {
  return readJson(TOKENS_FILE, {})[platform] || null;
}

export function saveTokens(platform, tokens) {
  const all = readJson(TOKENS_FILE, {});
  all[platform] = { ...(all[platform] || {}), ...tokens, saved_at: Date.now() };
  writeJson(TOKENS_FILE, all);
}

export function clearTokens(platform) {
  const all = readJson(TOKENS_FILE, {});
  delete all[platform];
  writeJson(TOKENS_FILE, all);
}

// ---------- jobs ----------
const jobs = new Map(readJson(JOBS_FILE, []).map((j) => [j.id, j]));

// Jobs that were mid-upload when the app last closed can't resume.
for (const j of jobs.values()) {
  if (j.state === "uploading" || j.state === "starting") {
    j.state = "failed";
    j.error = "Interrupted: Claude or the computer was closed during the upload. Start it again.";
  }
}

function persistJobs() {
  const list = [...jobs.values()].sort((a, b) => b.created - a.created).slice(0, 100);
  writeJson(JOBS_FILE, list);
}

let counter = 0;
export function createJob(platform, file, extra = {}) {
  const id = `${platform === "youtube" ? "yt" : "tt"}-${Date.now().toString(36)}${(counter++).toString(36)}`;
  const job = {
    id,
    platform,
    file,
    state: "starting",
    progress: 0,
    created: Date.now(),
    updated: Date.now(),
    ...extra,
  };
  jobs.set(id, job);
  persistJobs();
  return job;
}

export function updateJob(id, patch) {
  const job = jobs.get(id);
  if (!job) return;
  Object.assign(job, patch, { updated: Date.now() });
  persistJobs();
}

export function getJob(id) {
  return jobs.get(id) || null;
}

export function listJobs(limit = 10) {
  return [...jobs.values()].sort((a, b) => b.created - a.created).slice(0, limit);
}
