// Global state
let loggedIn = false;
let stats = { sent: 0, failed: 0, recipients: 0, history: [] };
let activityChart = null;
let statusChart = null;

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

// Profile Dropdown Elements
const profileTrigger = document.getElementById("profileTrigger");
const profileDropdown = document.getElementById("profileDropdown");
const dropdownEmail = document.getElementById("dropdownEmail");
const dropdownLogin = document.getElementById("dropdownLogin");
const dropdownLogout = document.getElementById("dropdownLogout");

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
    if (viewId) switchView(viewId);
  });
});

window.switchView = switchView;

// Dropdown Toggle Logic
if (profileTrigger && profileDropdown) {
  profileTrigger.addEventListener("click", (e) => {
    e.stopPropagation();
    profileDropdown.classList.toggle("active");
  });

  document.addEventListener("click", () => {
    profileDropdown.classList.remove("active");
  });

  profileDropdown.addEventListener("click", (e) => {
    e.stopPropagation();
  });
}

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
  logoutButton.addEventListener("click", logout);
}

if (dropdownLogout) {
  dropdownLogout.addEventListener("click", logout);
}

async function logout() {
  await fetch("/api/logout", { method: "POST" });
  window.location.reload(); 
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
      if (!response.ok || !result.ok) throw new Error(result.message || "Email could not be sent.");

      showMessage(result.message, "success");
      setStatus("Sent");
      loadStats(); // Reload stats after sending
    } catch (error) {
      showMessage(error.message, "error");
      setStatus("Error");
    } finally {
      setLoading(false);
    }
  });
}

// Data Fetching
async function loadSession() {
  try {
    const response = await fetch("/api/session");
    const session = await response.json();
    loggedIn = Boolean(session.loggedIn);
    
    const emailStr = loggedIn ? session.email : "Not logged in";
    if (accountEmail) accountEmail.textContent = emailStr;
    if (dropdownEmail) dropdownEmail.textContent = emailStr;

    // Handle Avatar
    const userAvatar = document.getElementById("userAvatar");
    if (userAvatar) {
      if (loggedIn && session.picture) {
        userAvatar.style.backgroundImage = `url('${session.picture}')`;
        userAvatar.style.backgroundSize = "cover";
        userAvatar.style.backgroundColor = "transparent";
      } else {
        userAvatar.style.backgroundImage = "none";
        userAvatar.style.backgroundColor = "#e2e8f0";
      }
    }
    
    // Toggle Visibility
    if (loginButton) loginButton.style.display = loggedIn ? 'none' : 'flex';
    if (logoutButton) logoutButton.hidden = !loggedIn;
    if (dropdownLogin) dropdownLogin.style.display = loggedIn ? 'none' : 'block';
    if (dropdownLogout) dropdownLogout.style.display = loggedIn ? 'block' : 'none';
    
    if (sendButton) sendButton.disabled = !loggedIn;

    if (loggedIn) {
      const activeOAuthItem = document.getElementById("activeOAuthItem");
      const oauthActiveEmail = document.getElementById("oauthActiveEmail");
      if (activeOAuthItem) activeOAuthItem.hidden = false;
      if (oauthActiveEmail) oauthActiveEmail.textContent = session.email;
    }

    setStatus(loggedIn ? "Ready" : "Login needed");
  } catch {
    loggedIn = false;
  }
}

async function loadStats() {
  try {
    const response = await fetch("/api/stats");
    stats = await response.json();
    renderStats();
    renderCharts();
  } catch (e) {
    console.error("Failed to load stats", e);
  }
}

// Rendering
function renderStats() {
  const sentEl = document.getElementById("statSent");
  const recipientsEl = document.getElementById("statRecipients");
  const deliveredEl = document.getElementById("statDelivered");
  const rateEl = document.getElementById("statDeliveryRate");
  const historyBody = document.getElementById("historyTableBody");
  const totalSentEl = document.getElementById("statusTotal");
  const usageFill = document.getElementById("usageFill");
  const usageText = document.getElementById("usageText");

  if (sentEl) sentEl.textContent = stats.sent.toLocaleString();
  if (recipientsEl) recipientsEl.textContent = stats.recipients.toLocaleString();
  if (deliveredEl) deliveredEl.textContent = stats.sent.toLocaleString();
  if (totalSentEl) totalSentEl.textContent = stats.sent.toLocaleString();

  const rate = stats.sent > 0 ? 100 : 0;
  if (rateEl) rateEl.textContent = `${rate}%`;

  // Usage Bar (Example: 100 limit)
  const usage = Math.min((stats.sent / 100) * 100, 100);
  if (usageFill) usageFill.style.width = `${usage}%`;
  if (usageText) usageText.textContent = `${stats.sent} / 100 emails used`;

  if (historyBody) {
    if (stats.history.length === 0) {
      historyBody.innerHTML = '<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 40px;">No emails sent yet.</td></tr>';
    } else {
      historyBody.innerHTML = stats.history.map(item => `
        <tr>
          <td style="font-weight: 500;">${item.subject}</td>
          <td>${item.recipient}</td>
          <td><span class="status-badge ${item.status}">${item.status.charAt(0).toUpperCase() + item.status.slice(1)}</span></td>
          <td style="color: var(--text-muted);">${formatDate(item.timestamp)}</td>
        </tr>
      `).join('');
    }
  }
}

function renderCharts() {
  const activityCtx = document.getElementById('activityChart')?.getContext('2d');
  const statusCtx = document.getElementById('statusChart')?.getContext('2d');

  if (activityCtx) {
    if (activityChart) activityChart.destroy();
    activityChart = new Chart(activityCtx, {
      type: 'line',
      data: {
        labels: ['Jun 20', 'Jun 21', 'Jun 22', 'Jun 23', 'Jun 24', 'Jun 25', 'Jun 26'],
        datasets: [{
          label: 'Emails Sent',
          data: [12, 19, 3, 5, 2, 3, stats.sent],
          borderColor: '#10b981',
          backgroundColor: 'rgba(16, 185, 129, 0.1)',
          fill: true,
          tension: 0.4
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } },
        scales: { y: { beginAtZero: true, grid: { display: false } }, x: { grid: { display: false } } }
      }
    });
  }

  if (statusCtx) {
    if (statusChart) statusChart.destroy();
    statusChart = new Chart(statusCtx, {
      type: 'doughnut',
      data: {
        labels: ['Delivered', 'Pending', 'Failed'],
        datasets: [{
          data: [stats.sent, 0, stats.failed],
          backgroundColor: ['#10b981', '#f59e0b', '#ef4444'],
          borderWidth: 0,
          cutout: '80%'
        }]
      },
      options: {
        responsive: true,
        plugins: { legend: { display: false } }
      }
    });
  }
}

// Helpers
function updateRecipientCount() {
  if (recipientCount && recipientsInput) {
    recipientCount.textContent = parseRecipients(recipientsInput.value).length;
  }
}

function parseRecipients(value) {
  if (!value) return [];
  return value.split(/[\s,;]+/).map(e => e.trim()).filter(Boolean).filter((e, i, a) => a.indexOf(e) === i);
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
  if (statusPill) statusPill.textContent = text;
}

function setLoading(isLoading) {
  if (sendButton) {
    sendButton.disabled = isLoading || !loggedIn;
    sendButton.textContent = isLoading ? "Sending..." : "Send Email";
  }
  if (clearButton) clearButton.disabled = isLoading;
}

function formatDate(ts) {
  if (!ts) return "Recently";
  const date = new Date(ts);
  return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ', ' + date.toLocaleDateString([], { month: 'short', day: 'numeric' });
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
loadSession().then(() => {
  loadStats();
});
updateRecipientCount();
