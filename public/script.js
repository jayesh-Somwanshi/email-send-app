const form = document.querySelector("#emailForm");
const recipientsInput = document.querySelector("#recipients");
const recipientCount = document.querySelector("#recipientCount");
const messageBox = document.querySelector("#messageBox");
const statusPill = document.querySelector("#statusPill");
const sendButton = document.querySelector("#sendButton");
const clearButton = document.querySelector("#clearButton");
const loginButton = document.querySelector("#loginButton");
const logoutButton = document.querySelector("#logoutButton");
const accountEmail = document.querySelector("#accountEmail");
const oauthClientId = document.querySelector("#oauthClientId");
const oauthOrigin = document.querySelector("#oauthOrigin");
const oauthRedirect = document.querySelector("#oauthRedirect");
const oauthLocalhostRedirect = document.querySelector("#oauthLocalhostRedirect");
const oauthStatus = document.querySelector("#oauthStatus");
const copyRedirectButton = document.querySelector("#copyRedirectButton");

let loggedIn = false;
let redirectUri = "";

if (recipientsInput) recipientsInput.addEventListener("input", updateRecipientCount);
if (clearButton) {
  clearButton.addEventListener("click", () => {
    form.reset();
    updateRecipientCount();
    showMessage("", "");
    setStatus("Ready");
  });
}

if (logoutButton) {
  logoutButton.addEventListener("click", async () => {
    await fetch("/api/logout", { method: "POST" });
    setSession({ loggedIn: false, email: "" });
    showMessage("Logged out.", "success");
    setStatus("Ready");
  });
}

if (copyRedirectButton) {
  copyRedirectButton.addEventListener("click", async () => {
    if (!redirectUri) {
      return;
    }

    await navigator.clipboard.writeText(redirectUri);
    copyRedirectButton.textContent = "Copied";
    setTimeout(() => {
      copyRedirectButton.textContent = "Copy Redirect URI";
    }, 1400);
  });
}

if (form) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    if (!loggedIn) {
      showMessage("Please login with Google before sending email.", "error");
      setStatus("Login needed");
      return;
    }

    setLoading(true);
    showMessage("", "");
    setStatus("Sending");

    const formData = new FormData(form);
    const data = Object.fromEntries(formData.entries());

    // Handle attachment
    const fileInput = document.querySelector("#attachment");
    if (fileInput && fileInput.files.length > 0) {
      const file = fileInput.files[0];
      try {
        data.attachment = {
          name: file.name,
          type: file.type,
          data: await toBase64(file)
        };
      } catch (error) {
        showMessage("Error reading attachment file.", "error");
        setLoading(false);
        return;
      }
    }

    try {
      const response = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data)
      });
      const result = await response.json();

      if (!response.ok || !result.ok) {
        throw new Error(result.message || "Email could not be sent.");
      }

      showMessage(result.message, "success");
      setStatus("Sent");
    } catch (error) {
      showMessage(error.message, "error");
      setStatus("Error");
    } finally {
      setLoading(false);
    }
  });
}

function updateRecipientCount() {
  if (recipientCount && recipientsInput) {
    recipientCount.textContent = parseRecipients(recipientsInput.value).length;
  }
}

function parseRecipients(value) {
  return value
    .split(/[\s,;]+/)
    .map((email) => email.trim())
    .filter(Boolean)
    .filter((email, index, all) => all.indexOf(email) === index);
}

function showMessage(text, type) {
  if (messageBox) {
    messageBox.textContent = text;
    messageBox.className = `message-box ${type || ""}`.trim();
    messageBox.hidden = !text;
  }
}

function setStatus(text) {
  if (statusPill) {
    statusPill.textContent = text;
  }
}

function setLoading(isLoading) {
  if (sendButton) sendButton.disabled = isLoading || !loggedIn;
  if (clearButton) clearButton.disabled = isLoading;
  if (sendButton) sendButton.textContent = isLoading ? "Sending..." : "Send Email";
}

async function loadSession() {
  try {
    const response = await fetch("/api/session");
    const session = await response.json();
    setSession(session);
  } catch {
    setSession({ loggedIn: false, email: "" });
  }
}

async function loadOAuthConfig() {
  try {
    const response = await fetch("/api/oauth-config");
    const config = await response.json();
    redirectUri = config.redirectUri || "";
    if (config.googleClientId && oauthClientId) oauthClientId.textContent = config.googleClientId;
    if (config.appOrigin && oauthOrigin) oauthOrigin.textContent = config.appOrigin;
    if (redirectUri && oauthRedirect) oauthRedirect.textContent = redirectUri;
    if (config.localhostRedirectUri && oauthLocalhostRedirect) oauthLocalhostRedirect.textContent = config.localhostRedirectUri;

    if (config.googleClientConfigured && config.googleSecretConfigured) {
      if (oauthStatus) {
        oauthStatus.textContent = "Paste both redirect URIs into this same OAuth Client ID.";
        oauthStatus.className = "oauth-status success";
      }
    } else {
      if (oauthStatus) {
        oauthStatus.textContent = "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env";
        oauthStatus.className = "oauth-status error";
      }
    }
  } catch {
    if (oauthStatus) {
      oauthStatus.textContent = "Could not load OAuth setup details.";
      oauthStatus.className = "oauth-status error";
    }
  }
}

function setSession(session) {
  loggedIn = Boolean(session.loggedIn);
  if (accountEmail) accountEmail.textContent = loggedIn ? session.email : "Not logged in";
  if (loginButton) loginButton.hidden = loggedIn;
  if (logoutButton) logoutButton.hidden = !loggedIn;
  if (sendButton) sendButton.disabled = !loggedIn;
  setStatus(loggedIn ? "Ready" : "Login needed");
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => {
      // Remove prefix "data:*/*;base64,"
      const base64String = reader.result.split(",")[1];
      resolve(base64String);
    };
    reader.onerror = (error) => reject(error);
  });
}

updateRecipientCount();
loadSession();
loadOAuthConfig();
