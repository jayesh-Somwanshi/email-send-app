const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const http = require("http");
const https = require("https");

const STATS_FILE = path.join(__dirname, "data", "stats.json");

loadEnv(path.join(__dirname, ".env"));

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC_DIR = path.join(__dirname, "public");

// Dynamic APP_ORIGIN detection for Vercel
let APP_ORIGIN = process.env.APP_ORIGIN;
if (!APP_ORIGIN && process.env.VERCEL_URL) {
  APP_ORIGIN = `https://${process.env.VERCEL_URL}`;
}
if (!APP_ORIGIN) {
  APP_ORIGIN = `http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`;
}

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL_SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const GOOGLE_SCOPE = "openid email https://www.googleapis.com/auth/gmail.send";

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
      const result = await handleSend(req, res, body);
      sendJson(res, 200, result);
      return;
    }

    if (req.method === "GET" && req.url === "/api/stats") {
      sendJson(res, 200, getStats());
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

async function handleSend(req, res, payload) {
  const session = await requireGoogleSession(req);
  const recipients = parseRecipients(payload.recipients);
  const subject = String(payload.subject || "").trim();
  const content = String(payload.content || "").trim();
  const signature = String(payload.signature || "").trim();
  const attachment = payload.attachment; // { name, type, data }
  const contentType = payload.format === "html" ? "html" : "plain";

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
  const accessToken = await ensureAccessToken(session, res);

  let successCount = 0;
  let lastError = null;

  for (const recipient of recipients) {
    try {
      const message = createMessage({
        from,
        to: [recipient],
        subject,
        content,
        contentType,
        signature,
        attachment
      });

      await sendGmailApiMessage(accessToken, message);
      successCount++;
    } catch (error) {
      lastError = error;
      console.error(`Failed to send to ${recipient}:`, error);
    }
  }

  if (successCount === 0 && lastError) {
    recordEmail(recipients, subject, false);
    throw lastError;
  }

  recordEmail(recipients, subject, true);
  return {
    ok: true,
    message: `Email sent separately to ${successCount} recipient${successCount === 1 ? "" : "s"}${
      recipients.length > successCount ? ` (${recipients.length - successCount} failed)` : ""
      }.`,
    count: successCount
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
  const userInfo = getUserInfoFromIdToken(token.id_token);

  if (!userInfo.email) {
    throw publicError(400, "Google did not return an email address. Please try again.");
  }

  res.writeHead(302, {
    Location: "/",
    "Set-Cookie": [
      cookie("session_ext", sealSession({
        email: userInfo.email,
        picture: userInfo.picture,
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + Number(token.expires_in || 3600) * 1000
      }), { maxAge: 86400, httpOnly: true }),
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

async function refreshAccessToken(session, res) {
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

  // Persist updated session back to cookie
  if (res) {
    res.setHeader("Set-Cookie", cookie("session_ext", sealSession(session), { maxAge: 86400, httpOnly: true }));
  }

  return session.accessToken;
}

async function ensureAccessToken(session, res) {
  if (session.expiresAt - Date.now() > 60000) {
    return session.accessToken;
  }

  return refreshAccessToken(session, res);
}

async function requireGoogleSession(req) {
  const session = getSession(req);

  if (!session) {
    throw publicError(401, "Please login with Google before sending email.");
  }

  return session;
}

function getSession(req) {
  const sessionExt = parseCookies(req).session_ext;
  return sessionExt ? unsealSession(sessionExt) : null;
}

function getSessionView(req) {
  const session = getSession(req);

  return {
    ok: true,
    loggedIn: Boolean(session),
    email: session ? session.email : "",
    picture: session ? session.picture : ""
  };
}

function getOAuthConfigView() {
  const clientId = process.env.GOOGLE_CLIENT_ID || "";

  return {
    ok: true,
    appOrigin: APP_ORIGIN,
    redirectUri: getRedirectUri(),
    localhostRedirectUri: "https://email-send-app-two.vercel.app/auth/google/callback",
    loopbackRedirectUri: "https://email-send-app-two.vercel.app/auth/google/callback",
    googleClientId: maskClientId(clientId),
    googleClientConfigured: Boolean(process.env.GOOGLE_CLIENT_ID),
    googleSecretConfigured: Boolean(process.env.GOOGLE_CLIENT_SECRET)
  };
}

function destroySession(req, res) {
  res.setHeader("Set-Cookie", cookie("session_ext", "", { maxAge: 0, httpOnly: true }));
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
  if (process.env.GOOGLE_REDIRECT_URI) {
    return process.env.GOOGLE_REDIRECT_URI;
  }
  return `${APP_ORIGIN}/auth/google/callback`;
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

function createMessage({ from, to, subject, content, contentType, signature, attachment }) {
  const boundary = `----=_Part_${Date.now()}_${crypto.randomBytes(8).toString("hex")}`;
  const messageId = `${Date.now()}.${crypto.randomBytes(8).toString("hex")}@email-send-app`;

  // If content is plain text, wrap it in a clean, full-width professional HTML structure.
  let fullContent = "";
  if (contentType === "plain") {
    // Escape and convert double newlines to paragraphs for consistent spacing
    const paragraphs = String(content || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .split(/\n\s*\n/)
      .map(p => p.trim())
      .filter(Boolean)
      .map(p => `<p style="margin: 0 0 16px 0;">${p.replace(/\n/g, "<br>")}</p>`)
      .join("");

    const escapedSignature = signature ? String(signature)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>") : "";

    fullContent = `
<div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 16px; line-height: 1.6; color: #202124; max-width: 100%; margin: 0 auto; padding: 20px;">
  <div style="margin-bottom: 32px;">
    ${paragraphs}
  </div>
  ${escapedSignature ? `
  <div style="border-top: 1px solid #e8eaed; padding-top: 24px; margin-top: 24px; color: #5f6368; font-size: 14px;">
    ${escapedSignature}
  </div>` : ""}
</div>
    `.trim();
    contentType = "html";
  } else {
    // If already HTML, just combine with signature if provided
    fullContent = signature ? `${content}<br><br>${signature}` : content;
  }

  const headers = [
    `From: ${formatAddress(from)}`,
    `To: ${to.join(", ")}`,
    `Subject: ${encodeHeader(subject)}`,
    `Message-ID: <${messageId}>`,
    `Date: ${new Date().toUTCString()}`,
    "MIME-Version: 1.0"
  ];

  if (!attachment) {
    headers.push(`Content-Type: text/${contentType}; charset=utf-8`);
    headers.push("Content-Transfer-Encoding: 8bit");
    return `${headers.join("\r\n")}\r\n\r\n${fullContent}\r\n`;
  }

  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);

  let body = `--${boundary}\r\n`;
  body += `Content-Type: text/${contentType}; charset=utf-8\r\n`;
  body += "Content-Transfer-Encoding: 8bit\r\n\r\n";
  body += `${fullContent}\r\n\r\n`;

  body += `--${boundary}\r\n`;
  // QUOTE the name and filename to handle spaces and special characters correctly
  body += `Content-Type: ${attachment.type || "application/octet-stream"}; name="${attachment.name}"\r\n`;
  body += `Content-Disposition: attachment; filename="${attachment.name}"\r\n`;
  body += "Content-Transfer-Encoding: base64\r\n\r\n";
  body += `${attachment.data}\r\n\r\n`;
  body += `--${boundary}--`;

  return `${headers.join("\r\n")}\r\n\r\n${body}`;
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

function getUserInfoFromIdToken(idToken) {
  if (!idToken) {
    return { email: "", picture: "" };
  }

  const parts = idToken.split(".");
  if (parts.length < 2) {
    return { email: "", picture: "" };
  }

  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return {
      email: typeof payload.email === "string" ? payload.email : "",
      picture: typeof payload.picture === "string" ? payload.picture : ""
    };
  } catch {
    return { email: "", picture: "" };
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

function sealSession(payload) {
  const key = getCryptoKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return `${iv.toString("hex")}.${encrypted.toString("hex")}`;
}

function unsealSession(token) {
  try {
    const [ivHex, encryptedHex] = token.split(".");
    if (!ivHex || !encryptedHex) return null;
    const key = getCryptoKey();
    const iv = Buffer.from(ivHex, "hex");
    const encrypted = Buffer.from(encryptedHex, "hex");
    const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return JSON.parse(decrypted.toString("utf8"));
  } catch (e) {
    console.error("Session decryption failed:", e);
    return null;
  }
}

function getCryptoKey() {
  const secret = process.env.SESSION_SECRET || process.env.GOOGLE_CLIENT_SECRET || "default_fallback_secret_32_chars_long!!";
  // Hash secret to ensure it's exactly 32 bytes for aes-256
  return crypto.createHash("sha256").update(secret).digest();
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

function getStats() {
  try {
    if (!fs.existsSync(STATS_FILE)) {
      return { sent: 0, failed: 0, recipients: 0, history: [] };
    }
    const data = fs.readFileSync(STATS_FILE, "utf-8");
    return JSON.parse(data);
  } catch (error) {
    console.error("Error reading stats:", error);
    return { sent: 0, failed: 0, recipients: 0, history: [] };
  }
}

function recordEmail(recipientList, subject, success) {
  try {
    const stats = getStats();
    if (success) {
      stats.sent += 1;
      stats.recipients += recipientList.length;
    } else {
      stats.failed += 1;
    }

    // Add to history (keep last 20)
    const entry = {
      subject,
      recipient: recipientList.length > 1 ? `${recipientList[0]} + ${recipientList.length - 1} more` : recipientList[0],
      status: success ? "sent" : "failed",
      date: new RegExp(/^\d+ minutes ago/).test("2 mins ago") ? "Just now" : new Date().toISOString() // Simpler for demo
    };
    
    // For realistic dates in demo, let's use a real timestamp
    entry.timestamp = Date.now();

    stats.history.unshift(entry);
    if (stats.history.length > 20) stats.history.pop();

    fs.writeFileSync(STATS_FILE, JSON.stringify(stats, null, 2));
  } catch (error) {
    console.error("Error recording email:", error);
  }
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
