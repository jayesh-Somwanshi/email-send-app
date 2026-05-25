const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

loadEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_DIR = path.join(__dirname, "public");
const APP_ORIGIN = process.env.APP_ORIGIN || `http://${HOST}:${PORT}`;
const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const GOOGLE_SCOPE = "openid email https://www.googleapis.com/auth/gmail.send";
const sessions = new Map();

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/auth/google") {
      redirectToGoogle(req, res);
      return;
    }

    if (req.method === "GET" && req.url.startsWith("/auth/google/callback")) {
      await handleGoogleCallback(req, res);
      return;
    }

    if (req.method === "GET" && req.url === "/api/session") {
      sendJson(res, 200, getSessionView(req));
      return;
    }

    if (req.method === "GET" && req.url === "/api/oauth-config") {
      sendJson(res, 200, getOAuthConfigView());
      return;
    }

    if (req.method === "POST" && req.url === "/api/logout") {
      destroySession(req, res);
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === "POST" && req.url === "/api/send") {
      const body = await readJson(req);
      const result = await handleSend(req, body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET") {
      serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { ok: false, message: "Method not allowed." });
  } catch (error) {
    const status = error.statusCode || 500;
    sendJson(res, status, {
      ok: false,
      message: error.publicMessage || error.message || "Something went wrong."
    });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Email Send Application running at http://${HOST}:${PORT}`);
});

async function handleSend(req, payload) {
  const session = await requireGoogleSession(req);
  const recipients = parseRecipients(payload.recipients);
  const subject = String(payload.subject || "").trim();
  const content = String(payload.content || "").trim();
  const contentType = payload.format === "html" ? "html" : "text";

  if (!recipients.length) {
    throw publicError(400, "Please enter at least one valid email address.");
  }

  if (!subject) {
    throw publicError(400, "Please enter an email subject.");
  }

  if (!content) {
    throw publicError(400, "Please enter the email content.");
  }

  const invalid = recipients.filter((email) => !isEmail(email));
  if (invalid.length) {
    throw publicError(400, `Invalid email address: ${invalid[0]}`);
  }

  const senderName = String(payload.senderName || "").trim();
  const from = senderName ? `${senderName} <${session.email}>` : session.email;
  const message = createMessage({
    from,
    to: recipients,
    subject,
    content,
    contentType
  });

  await sendGmailApiMessage(await ensureAccessToken(session), message);

  return {
    ok: true,
    message: `Email sent to ${recipients.length} recipient${recipients.length === 1 ? "" : "s"}.`,
    count: recipients.length
  };
}

function redirectToGoogle(req, res) {
  assertGoogleConfig();

  const state = randomId();
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: getRedirectUri(),
    response_type: "code",
    scope: GOOGLE_SCOPE,
    access_type: "offline",
    prompt: "consent",
    state
  });

  res.writeHead(302, {
    Location: `${GOOGLE_AUTH_URL}?${params.toString()}`,
    "Set-Cookie": cookie("oauth_state", state, { maxAge: 600, httpOnly: true })
  });
  res.end();
}

async function handleGoogleCallback(req, res) {
  assertGoogleConfig();

  const url = new URL(req.url, APP_ORIGIN);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookies = parseCookies(req);

  if (!code || !state || state !== cookies.oauth_state) {
    throw publicError(400, "Google login could not be verified. Please try again.");
  }

  const token = await exchangeCodeForToken(code);
  const email = getEmailFromIdToken(token.id_token);

  if (!email) {
    throw publicError(400, "Google did not return an email address. Please try again.");
  }

  const sessionId = randomId();
  sessions.set(sessionId, {
    email,
    accessToken: token.access_token,
    refreshToken: token.refresh_token,
    expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000
  });

  res.writeHead(302, {
    Location: "/",
    "Set-Cookie": [
      cookie("session_id", sessionId, { maxAge: 86400, httpOnly: true }),
      cookie("oauth_state", "", { maxAge: 0, httpOnly: true })
    ]
  });
  res.end();
}

async function exchangeCodeForToken(code) {
  const body = new URLSearchParams({
    code,
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    redirect_uri: getRedirectUri(),
    grant_type: "authorization_code"
  }).toString();

  return postForm(GOOGLE_TOKEN_URL, body);
}

async function refreshAccessToken(session) {
  if (!session.refreshToken) {
    throw publicError(401, "Your Google login expired. Please login with Google again.");
  }

  const body = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    client_secret: process.env.GOOGLE_CLIENT_SECRET,
    refresh_token: session.refreshToken,
    grant_type: "refresh_token"
  }).toString();

  const token = await postForm(GOOGLE_TOKEN_URL, body);
  session.accessToken = token.access_token;
  session.expiresAt = Date.now() + Number(token.expires_in || 3600) * 1000;
  return session.accessToken;
}

async function ensureAccessToken(session) {
  if (session.expiresAt - Date.now() > 60000) {
    return session.accessToken;
  }

  return refreshAccessToken(session);
}

async function requireGoogleSession(req) {
  const session = getSession(req);

  if (!session) {
    throw publicError(401, "Please login with Google before sending email.");
  }

  return session;
}

function getSession(req) {
  const sessionId = parseCookies(req).session_id;
  return sessionId ? sessions.get(sessionId) : null;
}

function getSessionView(req) {
  const session = getSession(req);

  return {
    ok: true,
    loggedIn: Boolean(session),
    email: session ? session.email : ""
  };
}

function getOAuthConfigView() {
  const clientId = process.env.GOOGLE_CLIENT_ID || "";

  return {
    ok: true,
    appOrigin: APP_ORIGIN,
    redirectUri: getRedirectUri(),
    localhostRedirectUri: "http://localhost:3000/auth/google/callback",
    loopbackRedirectUri: "http://127.0.0.1:3000/auth/google/callback",
    googleClientId: maskClientId(clientId),
    googleClientConfigured: Boolean(process.env.GOOGLE_CLIENT_ID),
    googleSecretConfigured: Boolean(process.env.GOOGLE_CLIENT_SECRET)
  };
}

function destroySession(req, res) {
  const sessionId = parseCookies(req).session_id;
  if (sessionId) {
    sessions.delete(sessionId);
  }

  res.setHeader("Set-Cookie", cookie("session_id", "", { maxAge: 0, httpOnly: true }));
}

function assertGoogleConfig() {
  const missing = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"].filter((key) => !process.env[key]);

  if (missing.length) {
    throw publicError(
      500,
      `Google login is not configured. Missing ${missing.join(", ")} in your .env file.`
    );
  }
}

function getRedirectUri() {
  return process.env.GOOGLE_REDIRECT_URI || `${APP_ORIGIN}/auth/google/callback`;
}

function parseRecipients(input) {
  return String(input || "")
    .split(/[\s,;]+/)
    .map((email) => email.trim())
    .filter(Boolean)
    .filter((email, index, all) => all.indexOf(email) === index);
}

function isEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function createMessage({ from, to, subject, content, contentType }) {
  const messageId = `${Date.now()}.${crypto.randomBytes(8).toString("hex")}@email-send-app`;
  const headers = [
    `From: ${formatAddress(from)}`,
    `To: ${to.join(", ")}`,
    `Subject: ${encodeHeader(subject)}`,
    `Message-ID: <${messageId}>`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0",
    `Content-Type: text/${contentType}; charset=utf-8`,
    "Content-Transfer-Encoding: 8bit"
  ];

  return `${headers.join("\r\n")}\r\n\r\n${content}\r\n`;
}

function formatAddress(address) {
  if (/<[^>]+>$/.test(address)) {
    return address;
  }

  return address.includes("@") ? `<${address}>` : address;
}

function encodeHeader(value) {
  if (/^[\x00-\x7F]*$/.test(value)) {
    return value.replace(/[\r\n]/g, " ");
  }

  return `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function sendGmailApiMessage(accessToken, message) {
  const raw = Buffer.from(message, "utf8").toString("base64url");
  const body = JSON.stringify({ raw });
  const target = new URL(GMAIL_SEND_URL);

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        method: "POST",
        hostname: target.hostname,
        path: target.pathname,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          let payload = {};
          try {
            payload = JSON.parse(data || "{}");
          } catch {
            reject(publicError(502, "Gmail returned an invalid response."));
            return;
          }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              publicError(
                response.statusCode === 401 || response.statusCode === 403 ? 403 : 502,
                payload.error?.message || "Gmail could not send the email."
              )
            );
            return;
          }

          resolve(payload);
        });
      }
    );

    request.on("error", () => reject(publicError(502, "Could not connect to Gmail.")));
    request.end(body);
  });
}

function serveStatic(req, res) {
  const requestedPath = decodeURIComponent(new URL(req.url, `http://${req.headers.host}`).pathname);
  const relativePath = requestedPath === "/" ? "/index.html" : requestedPath;
  const filePath = path.normalize(path.join(PUBLIC_DIR, relativePath));

  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { ok: false, message: "Forbidden." });
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      sendJson(res, 404, { ok: false, message: "Not found." });
      return;
    }

    res.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream"
    });
    res.end(data);
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(publicError(413, "Request is too large."));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(publicError(400, "Invalid JSON."));
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function postForm(url, body) {
  const target = new URL(url);

  return new Promise((resolve, reject) => {
    const request = https.request(
      {
        method: "POST",
        hostname: target.hostname,
        path: `${target.pathname}${target.search}`,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(body)
        }
      },
      (response) => {
        let data = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          data += chunk;
        });
        response.on("end", () => {
          let payload;
          try {
            payload = JSON.parse(data || "{}");
          } catch {
            reject(publicError(502, "Google returned an invalid response."));
            return;
          }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(
              publicError(
                502,
                payload.error_description || payload.error || "Google login failed."
              )
            );
            return;
          }

          resolve(payload);
        });
      }
    );

    request.on("error", () => reject(publicError(502, "Could not connect to Google.")));
    request.end(body);
  });
}

function getEmailFromIdToken(idToken) {
  if (!idToken) {
    return "";
  }

  const parts = idToken.split(".");
  if (parts.length < 2) {
    return "";
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return typeof payload.email === "string" ? payload.email : "";
  } catch {
    return "";
  }
}

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const result = {};

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    result[key] = decodeURIComponent(value);
  }

  return result;
}

function cookie(name, value, options = {}) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "SameSite=Lax"
  ];

  if (options.httpOnly) {
    parts.push("HttpOnly");
  }

  if (typeof options.maxAge === "number") {
    parts.push(`Max-Age=${options.maxAge}`);
  }

  return parts.join("; ");
}

function randomId() {
  return crypto.randomBytes(24).toString("hex");
}

function maskClientId(clientId) {
  if (!clientId) {
    return "";
  }

  const visible = clientId.slice(-28);
  return `...${visible}`;
}

function publicError(statusCode, publicMessage) {
  const error = new Error(publicMessage);
  error.statusCode = statusCode;
  error.publicMessage = publicMessage;
  return error;
}

function loadEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
