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

recipientsInput.addEventListener("input", updateRecipientCount);
clearButton.addEventListener("click", () => {
  form.reset();
  updateRecipientCount();
  showMessage("", "");
  setStatus("Ready");
});

logoutButton.addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  setSession({ loggedIn: false, email: "" });
  showMessage("Logged out.", "success");
  setStatus("Ready");
});

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

  const data = Object.fromEntries(new FormData(form).entries());

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

function updateRecipientCount() {
  recipientCount.textContent = parseRecipients(recipientsInput.value).length;
}

function parseRecipients(value) {
  return value
    .split(/[\s,;]+/)
    .map((email) => email.trim())
    .filter(Boolean)
    .filter((email, index, all) => all.indexOf(email) === index);
}

function showMessage(text, type) {
  messageBox.textContent = text;
  messageBox.className = `message-box ${type || ""}`.trim();
  messageBox.hidden = !text;
}

function setStatus(text) {
  statusPill.textContent = text;
}

function setLoading(isLoading) {
  sendButton.disabled = isLoading || !loggedIn;
  clearButton.disabled = isLoading;
  sendButton.textContent = isLoading ? "Sending..." : "Send Email";
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
    oauthClientId.textContent = config.googleClientId || "Not set";
    oauthOrigin.textContent = config.appOrigin || "Not set";
    oauthRedirect.textContent = redirectUri || "Not set";
    oauthLocalhostRedirect.textContent = config.localhostRedirectUri || "Not set";

    if (config.googleClientConfigured && config.googleSecretConfigured) {
      oauthStatus.textContent = "Paste both redirect URIs into this same OAuth Client ID.";
      oauthStatus.className = "oauth-status success";
    } else {
      oauthStatus.textContent = "Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env";
      oauthStatus.className = "oauth-status error";
    }
  } catch {
    oauthStatus.textContent = "Could not load OAuth setup details.";
    oauthStatus.className = "oauth-status error";
  }
}

function setSession(session) {
  loggedIn = Boolean(session.loggedIn);
  accountEmail.textContent = loggedIn ? session.email : "Not logged in";
  loginButton.hidden = loggedIn;
  logoutButton.hidden = !loggedIn;
  sendButton.disabled = !loggedIn;
  setStatus(loggedIn ? "Ready" : "Login needed");
}

updateRecipientCount();
loadSession();
loadOAuthConfig();
