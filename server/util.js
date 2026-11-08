import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";

export const VIDEO_TYPES = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".avi": "video/x-msvideo",
  ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".3gp": "video/3gpp",
};

export const IMAGE_TYPES = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png" };

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Normalise a path the user/Claude typed (quotes, ~, file://). */
export function cleanPath(p) {
  let s = String(p).trim().replace(/^["']|["']$/g, "");
  if (s.startsWith("file:///")) s = decodeURIComponent(s.slice(process.platform === "win32" ? 8 : 7));
  if (s.startsWith("~")) s = path.join(process.env.USERPROFILE || process.env.HOME || "", s.slice(1));
  return path.resolve(s);
}

export function checkFile(p, allowed) {
  const file = cleanPath(p);
  let st;
  try {
    st = fs.statSync(file);
  } catch {
    throw new Error(`File not found: ${file}`);
  }
  if (!st.isFile()) throw new Error(`Not a file: ${file}`);
  if (st.size === 0) throw new Error(`File is empty: ${file}`);
  const ext = path.extname(file).toLowerCase();
  if (allowed && !allowed[ext]) {
    throw new Error(`Unsupported file type "${ext}". Supported: ${Object.keys(allowed).join(", ")}`);
  }
  return { file, size: st.size, ext, mime: allowed?.[ext] };
}

/** Read `length` bytes starting at `start` from a file. */
export async function readChunk(file, start, length) {
  const fh = await fs.promises.open(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const { bytesRead } = await fh.read(buf, 0, length, start);
    return bytesRead === length ? buf : buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

export function randomString(len = 64) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += chars[bytes[i] % chars.length];
  return out;
}

export function openBrowser(url) {
  try {
    let child;
    if (process.platform === "win32") {
      child = spawn("rundll32", ["url.dll,FileProtocolHandler", url], { detached: true, stdio: "ignore" });
    } else if (process.platform === "darwin") {
      child = spawn("open", [url], { detached: true, stdio: "ignore" });
    } else {
      child = spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
    }
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

const page = (title, msg, ok) => `<!doctype html><meta charset="utf-8"><title>${title}</title>
<body style="font-family:system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0;background:#0f1115;color:#e8e8e8">
<div style="text-align:center;max-width:460px;padding:24px"><div style="font-size:48px">${ok ? "✅" : "⚠️"}</div>
<h2>${title}</h2><p style="opacity:.8">${msg}</p></div></body>`;

const pendingLogins = new Map(); // platform -> server

/**
 * Start a one-shot loopback HTTP server for an OAuth redirect.
 * Resolves immediately with { port, redirectUri }. `onCode(params)` runs when the browser returns.
 */
export function startLoopback({ platform, port = 0, callbackPath = "/callback/", onCode }) {
  const old = pendingLogins.get(platform);
  if (old) old.close();

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      const norm = (s) => s.replace(/\/+$/, "");
      if (norm(url.pathname) !== norm(callbackPath)) {
        res.writeHead(404).end();
        return;
      }
      const params = Object.fromEntries(url.searchParams);
      try {
        const label = await onCode(params);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page("Connected!", `${label}. You can close this tab and go back to Claude.`, true));
      } catch (e) {
        res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
        res.end(page("Connection failed", String(e.message || e), false));
      } finally {
        setTimeout(() => server.close(), 500);
        pendingLogins.delete(platform);
      }
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1", () => {
      pendingLogins.set(platform, server);
      // Give up after 10 minutes.
      setTimeout(() => {
        server.close();
        pendingLogins.delete(platform);
      }, 10 * 60 * 1000).unref();
      const p = server.address().port;
      resolve({ port: p, redirectUri: `http://127.0.0.1:${p}${callbackPath}` });
    });
  });
}

/** fetch with retries on network errors and 5xx/429. */
export async function fetchRetry(url, opts = {}, { tries = 5, label = "request" } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, opts);
      if (res.status >= 500 || res.status === 429) {
        lastErr = new Error(`${label} failed: HTTP ${res.status} ${await res.text().catch(() => "")}`);
      } else {
        return res;
      }
    } catch (e) {
      lastErr = e;
    }
    await sleep(Math.min(30000, 1000 * 2 ** i) + Math.random() * 500);
  }
  throw lastErr;
}
