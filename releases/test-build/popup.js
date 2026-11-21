
function getDateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${year}-${month}-${day}`;
}

// Convert seconds into readable time.
function formatTime(totalSeconds = 0) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));

  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;

  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }

  if (minutes > 0) {
    return `${minutes}m ${remainingSeconds}s`;
  }

  return `${remainingSeconds}s`;
}

function getLastSevenDays(daily = {}) {
  const result = [];

  for (let offset = 6; offset >= 0; offset--) {
    const date = new Date();
    date.setHours(12, 0, 0, 0);
    date.setDate(date.getDate() - offset);

    const key = getDateKey(date);
    const record = daily[key];

    result.push({
      key,
      label: date.toLocaleDateString("en-IN", {
        weekday: "short"
      }),
      total: Number(record?.totalPosts) || 0,
      isToday: offset === 0
    });
  }

  return result;
}

function setText(id, value) {
  const element = document.getElementById(id);

  if (element) {
    element.textContent = value;
  }
}

function renderWeeklyChart(days) {
  const chart = document.getElementById("weeklyChart");

  if (!chart) return;

  chart.replaceChildren();

  const maxValue = Math.max(
    1,
    ...days.map(day => day.total)
  );

  days.forEach(day => {
    const column = document.createElement("div");
    column.className = "chart-day";

    const count = document.createElement("span");
    count.className = "bar-count";
    count.textContent = day.total;

    const track = document.createElement("div");
    track.className = "bar-track";

    const bar = document.createElement("div");
    bar.className = day.isToday ? "bar today" : "bar";

    const height = day.total === 0
      ? 3
      : Math.max(5, (day.total / maxValue) * 90);

    bar.style.height = `${height}px`;
    bar.title = `${day.key}: ${day.total} posts`;

    const label = document.createElement("span");
    label.className = "day-label";
    label.textContent = day.label;

    track.appendChild(bar);
    column.append(count, track, label);
    chart.appendChild(column);
  });
}

function renderStats(stats) {
  const todayKey = getDateKey(new Date());

  const today = stats.daily?.[todayKey] || {
    totalPosts: 0,
    activeSeconds: 0,
    platforms: {}
  };

  const x = today.platforms?.x || {};
  const linkedin = today.platforms?.linkedin || {};

  // Today's post counts.
  setText("todayTotal", today.totalPosts || 0);

  setText("xPosts", `${x.posts || 0} posts`);
  setText("xVideos", x.videos || 0);

  setText(
    "linkedinPosts",
    `${linkedin.posts || 0} posts`
  );

  setText("linkedinVideos", linkedin.videos || 0);

  // Today's active time.
  setText(
    "todayActiveTime",
    formatTime(today.activeSeconds)
  );

  setText(
    "xActiveTime",
    formatTime(x.activeSeconds)
  );

  setText(
    "linkedinActiveTime",
    formatTime(linkedin.activeSeconds)
  );

  // Weekly post analytics.
  const days = getLastSevenDays(stats.daily || {});

  const weeklyTotal = days.reduce(
    (sum, day) => sum + day.total,
    0
  );

  setText("weeklyTotal", `${weeklyTotal} viewed`);
  setText("dailyAverage", (weeklyTotal / 7).toFixed(1));

  renderWeeklyChart(days);

  // Lifetime statistics.
  setText("lifetimeTotal", stats.totalPosts || 0);

  setText(
    "lifetimeActiveTime",
    formatTime(stats.activeSeconds)
  );
}

function renderTrackingState(enabled) {
  const button = document.getElementById("trackingToggle");
  const status = document.getElementById("trackingStatus");

  if (!button) return;

  button.textContent = enabled ? "Pause tracking" : "Resume tracking";
  button.setAttribute("aria-pressed", String(!enabled));
  button.classList.toggle("paused", !enabled);

  if (status) {
    status.textContent = enabled ? "● Tracking" : "● Paused";
    status.classList.toggle("paused", !enabled);
  }
}

function loadStats() {
  chrome.runtime.sendMessage(
    { type: "GET_STATS" },
    response => {
      if (chrome.runtime.lastError) {
        console.error(
          "[BrainWeb] Could not load statistics:",
          chrome.runtime.lastError.message
        );
        return;
      }

      if (response?.success && response.stats) {
        renderStats(response.stats);
        renderTrackingState(response.trackingEnabled !== false);
      }
    }
  );
}

document.getElementById("trackingToggle")?.addEventListener("click", event => {
  const button = event.currentTarget;
  button.disabled = true;

  chrome.runtime.sendMessage(
    {
      type: "SET_TRACKING",
      enabled: button.textContent !== "Resume tracking"
    },
    response => {
      button.disabled = false;

      if (chrome.runtime.lastError || !response?.success) {
        console.error(
          "[BrainWeb] Could not update tracking:",
          chrome.runtime.lastError?.message || response?.error || "Unknown error"
        );
        return;
      }

      renderTrackingState(response.trackingEnabled !== false);
    }
  );
});

// Initial load.
loadStats();

// Update popup whenever tracking data changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.stats?.newValue) {
    renderStats(changes.stats.newValue);
  }

  if (area === "local" && changes.trackingEnabled) {
    renderTrackingState(changes.trackingEnabled.newValue !== false);
  }
});