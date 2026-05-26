// Global state
let loggedIn = false;
let redirectUri = "";

// DOM Elements
const form = document.getElementById("emailForm");
const recipientsInput = document.getElementById("recipients");
const recipientCount = document.getElementById("recipientCount");
const clearButton = document.getElementById("clearButton");
const sendButton = document.getElementById("sendButton");
const loginButton = document.getElementById("loginButton");
const logoutButton = document.getElementById("logoutButton");
const statusPill = document.getElementById("statusPill");
const messageBox = document.getElementById("messageBox");
const accountEmail = document.getElementById("accountEmail");

// View Switching Logic
const navLinks = document.querySelectorAll(".nav-link[data-view]");
const views = document.querySelectorAll(".view");

function switchView(viewId) {
  views.forEach(v => v.classList.remove("active"));
  navLinks.forEach(l => l.classList.remove("active"));

  const targetView = document.getElementById(`${viewId}View`);
  const targetLink = document.querySelector(`.nav-link[data-view="${viewId}"]`);

  if (targetView) targetView.classList.add("active");
  if (targetLink) targetLink.classList.add("active");
}

navLinks.forEach(link => {
  link.addEventListener("click", (e) => {
    e.preventDefault();
    const viewId = link.getAttribute("data-view");
    switchView(viewId);
  });
});

// Expose switchView to global scope (for Quick Actions)
window.switchView = switchView;

// Event Listeners
if (recipientsInput) recipientsInput.addEventListener("input", updateRecipientCount);

if (clearButton) {
  clearButton.addEventListener("click", () => {
    if (form) form.reset();
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
    window.location.reload(); 
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

// Helpers
function updateRecipientCount() {
  if (recipientCount && recipientsInput) {
    recipientCount.textContent = parseRecipients(recipientsInput.value).length;
  }
}

function parseRecipients(value) {
  if (!value) return [];
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
    if (text) messageBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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
    setSession({ loggedIn: false });
  }
}

function setSession(session) {
  loggedIn = Boolean(session.loggedIn);
  if (accountEmail) accountEmail.textContent = loggedIn ? session.email : "Not logged in";
  
  if (loginButton) loginButton.style.display = loggedIn ? 'none' : 'flex';
  if (logoutButton) logoutButton.hidden = !loggedIn;
  
  if (sendButton) sendButton.disabled = !loggedIn;
  setStatus(loggedIn ? "Ready" : "Login needed");
}

function toBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = () => resolve(reader.result.split(",")[1]);
    reader.onerror = (error) => reject(error);
  });
}

// Initialize
loadSession();
updateRecipientCount();
