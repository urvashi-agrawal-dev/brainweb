
/* =========================================================
   BRAINWEB — BACKGROUND SERVICE WORKER
   ---------------------------------------------------------
   Features:
   1. Stores lifetime post analytics.
   2. Stores daily post analytics.
   3. Tracks active time on X and LinkedIn.
   4. Excludes background tabs and unfocused windows.
   5. Excludes inactive/idle pages.
   6. Splits sessions correctly at local midnight.
   7. Preserves sessions across page refreshes.
   8. Exposes analytics to the local dashboard.
========================================================= */


/* ---------------------------------------------------------
   1. DEFAULT DATA STRUCTURES
--------------------------------------------------------- */

const EMPTY_PLATFORM = () => ({
  posts: 0,
  videos: 0,
  articles: 0,
  images: 0,
  organic: 0,
  sponsored: 0,
  activeSeconds: 0,

  breakdown: {
    text: 0,
    video: 0,
    article: 0,
    image: 0
  }
});

const DEFAULT_STATS = {
  totalPosts: 0,
  activeSeconds: 0,

  platforms: {
    x: EMPTY_PLATFORM(),
    linkedin: EMPTY_PLATFORM()
  },

  updatedAt: null,
  daily: {}
};


/* ---------------------------------------------------------
   2. SESSION SETTINGS
--------------------------------------------------------- */

// Maximum time credited between two heartbeats.
const HEARTBEAT_MAX_GAP_MS = 15000;

// If a heartbeat is missing for more than this,
// don't recover the missing time.
const SESSION_RECOVERY_MS = 20000;


/* ---------------------------------------------------------
   3. SERIAL UPDATE QUEUE
--------------------------------------------------------- */

// Prevents multiple events from overwriting each other's
// changes to chrome.storage.local.

let updateQueue = Promise.resolve();

function enqueue(callback) {
  const task = updateQueue.then(callback);

  updateQueue = task.catch(error => {
    console.error("[BrainWeb] Update failed:", error);
  });

  return task;
}


/* ---------------------------------------------------------
   4. DATE HELPERS
--------------------------------------------------------- */

// Uses the browser's local timezone.
// Example: 2026-11-19

function getLocalDateKey(date = new Date()) {
  const year = date.getFullYear();

  const month = String(
    date.getMonth() + 1
  ).padStart(2, "0");

  const day = String(
    date.getDate()
  ).padStart(2, "0");

  return `${year}-${month}-${day}`;
}


/* ---------------------------------------------------------
   5. DATA CREATION AND NORMALIZATION
--------------------------------------------------------- */

function emptyPlatform() {
  return EMPTY_PLATFORM();
}


function createDailyRecord() {
  return {
    totalPosts: 0,
    activeSeconds: 0,

    platforms: {
      x: emptyPlatform(),
      linkedin: emptyPlatform()
    },

    updatedAt: null
  };
}


// Makes older platform records compatible with the
// current data structure.

function normalizePlatform(data = {}) {
  const defaults = emptyPlatform();

  return {
    ...defaults,
    ...data,

    posts: Number(data.posts) || 0,
    videos: Number(data.videos) || 0,
    articles: Number(data.articles) || 0,
    images: Number(data.images) || 0,

    organic: Number(data.organic) || 0,
    sponsored: Number(data.sponsored) || 0,

    activeSeconds: Number(data.activeSeconds) || 0,

    breakdown: {
      ...defaults.breakdown,
      ...(data.breakdown || {}),

      text: Number(data.breakdown?.text) || 0,
      video: Number(data.breakdown?.video) || 0,
      article: Number(data.breakdown?.article) || 0,
      image: Number(data.breakdown?.image) || 0
    }
  };
}


// Normalizes an individual daily record.
// This is important for records created by older versions
// that might not have activeSeconds or platform fields.

function normalizeDailyRecord(record = {}) {
  const defaults = createDailyRecord();

  return {
    ...defaults,
    ...record,

    totalPosts: Number(record.totalPosts) || 0,
    activeSeconds: Number(record.activeSeconds) || 0,

    platforms: {
      x: normalizePlatform(record.platforms?.x),
      linkedin: normalizePlatform(record.platforms?.linkedin)
    }
  };
}


// Normalizes the complete statistics object.

function normalizeStats(stats = {}) {
  const dailyRecords = Object.fromEntries(
    Object.entries(stats.daily || {}).map(
      ([dateKey, record]) => [
        dateKey,
        normalizeDailyRecord(record)
      ]
    )
  );

  return {
    ...DEFAULT_STATS,
    ...stats,

    totalPosts: Number(stats.totalPosts) || 0,
    activeSeconds: Number(stats.activeSeconds) || 0,

    platforms: {
      x: normalizePlatform(stats.platforms?.x),
      linkedin: normalizePlatform(stats.platforms?.linkedin)
    },

    daily: dailyRecords
  };
}


/* ---------------------------------------------------------
   6. POST COUNTER
--------------------------------------------------------- */

function incrementPlatform(data, contentType, isSponsored) {
  data.posts += 1;

  data.breakdown[contentType] += 1;

  if (contentType === "video") {
    data.videos += 1;
  }

  if (contentType === "article") {
    data.articles += 1;
  }

  if (contentType === "image") {
    data.images += 1;
  }

  if (isSponsored) {
    data.sponsored += 1;
  } else {
    data.organic += 1;
  }
}


/* ---------------------------------------------------------
   7. SENDER VALIDATION
--------------------------------------------------------- */

function validPlatform(platform) {
  return (
    platform === "x" ||
    platform === "linkedin"
  );
}


function validSender(platform, sender) {
  try {
    const url = new URL(sender.url);

    return (
      (
        platform === "x" &&
        url.hostname === "x.com"
      ) ||
      (
        platform === "linkedin" &&
        url.hostname === "www.linkedin.com"
      )
    );

  } catch {
    return false;
  }
}


/* ---------------------------------------------------------
   8. STORAGE HELPERS
--------------------------------------------------------- */

async function readState() {
  const result = await chrome.storage.local.get([
    "stats",
    "activeSession",
    "trackingEnabled"
  ]);

  return {
    stats: normalizeStats(result.stats),
    session: result.activeSession || null,
    trackingEnabled: result.trackingEnabled !== false
  };
}


async function saveStats(stats, session) {
  const timestamp = new Date().toISOString();

  stats.updatedAt = timestamp;

  const data = {
    stats
  };

  // undefined means preserve the existing session.
  // null means explicitly clear the active session.

  if (session !== undefined) {
    data.activeSession = session;
  }

  await chrome.storage.local.set(data);
}


/* ---------------------------------------------------------
   8b. STORAGE INITIALIZATION
--------------------------------------------------------- */

// Runs once when the service worker starts.
// Only missing keys are created; existing statistics,
// tracking preferences, and sessions are preserved.

async function initializeStorage() {
  const result = await chrome.storage.local.get([
    "stats",
    "trackingEnabled",
    "activeSession"
  ]);

  const updates = {};

  if (result.stats === undefined) {
    updates.stats = normalizeStats(DEFAULT_STATS);
  }

  if (result.trackingEnabled === undefined) {
    updates.trackingEnabled = true;
  }

  if (result.activeSession === undefined) {
    updates.activeSession = null;
  }

  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
}

// Enqueued before any listeners are registered, so it
// completes before tracking events or dashboard requests
// are processed by the serial update queue.

enqueue(initializeStorage);


/* ---------------------------------------------------------
   9. ACTIVE TIME — DATE-AWARE TRACKING
--------------------------------------------------------- */

// Adds a time interval to the correct daily records.
//
// If an interval crosses midnight, it is split into
// separate pieces and stored against the appropriate dates.
//
// Example:
// Wednesday 23:59:50 -> Thursday 00:00:10
//
// Wednesday receives 10 seconds.
// Thursday receives 10 seconds.

function addActiveInterval(
  stats,
  platform,
  startMs,
  endMs
) {
  if (
    !validPlatform(platform) ||
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs) ||
    endMs <= startMs
  ) {
    return;
  }

  let cursor = startMs;

  while (cursor < endMs) {
    const currentDate = new Date(cursor);

    // Calculate the next local midnight.
    const nextMidnight = new Date(
      currentDate.getFullYear(),
      currentDate.getMonth(),
      currentDate.getDate() + 1
    ).getTime();

    const segmentEnd = Math.min(
      endMs,
      nextMidnight
    );

    const seconds = Math.floor(
      (segmentEnd - cursor) / 1000
    );

    if (seconds > 0) {
      const dateKey = getLocalDateKey(currentDate);

      // Ensure this date exists.
      stats.daily[dateKey] ||= createDailyRecord();

      // Lifetime statistics.
      stats.activeSeconds += seconds;

      stats.platforms[platform].activeSeconds += seconds;

      // Daily statistics.
      stats.daily[dateKey].activeSeconds += seconds;

      stats.daily[dateKey]
        .platforms[platform]
        .activeSeconds += seconds;
    }

    cursor = segmentEnd;
  }
}


/* ---------------------------------------------------------
   10. TAB ELIGIBILITY
--------------------------------------------------------- */

// A tab is eligible only when:
// - It is the active tab.
// - Its window is focused.
// - It belongs to X or LinkedIn.

async function isTabEligible(tabId, platform) {
  try {
    const tab = await chrome.tabs.get(tabId);

    if (!tab.active) {
      return false;
    }

    if (!validSender(platform, { url: tab.url })) {
      return false;
    }

    const win = await chrome.windows.get(tab.windowId);

    return win.focused === true;

  } catch {
    return false;
  }
}


/* ---------------------------------------------------------
   11. SESSION RECOVERY
--------------------------------------------------------- */

// Returns the interval that can safely be credited
// since the previous heartbeat.
//
// The interval is capped to avoid counting a long period
// when the extension/browser was suspended.

function recoverableInterval(session, now) {
  if (!session) {
    return null;
  }

  const start = session.lastHeartbeatAt;

  const gap = now - start;

  if (
    !Number.isFinite(start) ||
    gap <= 0 ||
    gap > SESSION_RECOVERY_MS
  ) {
    return null;
  }

  return {
    start,
    end: Math.min(
      now,
      start + HEARTBEAT_MAX_GAP_MS
    )
  };
}


/* ---------------------------------------------------------
   12. CLOSE ACTIVE SESSION
--------------------------------------------------------- */

async function closeSession(expectedTabId = null) {
  const { stats, session } = await readState();

  if (!session) {
    return;
  }

  // Prevent one tab from closing another tab's session.
  if (
    expectedTabId !== null &&
    session.tabId !== expectedTabId
  ) {
    return;
  }

  const now = Date.now();

  const interval = recoverableInterval(
    session,
    now
  );

  if (interval) {
    addActiveInterval(
      stats,
      session.platform,
      interval.start,
      interval.end
    );
  }

  // Save statistics and clear the session.
  await saveStats(stats, null);

  console.log(
    "[BrainWeb] Session closed:",
    session.platform
  );
}


/* ---------------------------------------------------------
   13. HANDLE ACTIVE SESSION HEARTBEAT
--------------------------------------------------------- */

// Expected heartbeat message from content.js:
//
// {
//   type: "SESSION_HEARTBEAT",
//   platform: "x" | "linkedin",
//   visible: true,
//   pageFocused: true,
//   lastActivityAt: Date.now()
// }

async function handleHeartbeat(message, sender) {
  const platform = message.platform;

  const tabId = sender.tab?.id;

  // Validate sender.
  if (
    !validPlatform(platform) ||
    tabId === undefined ||
    !validSender(platform, sender)
  ) {
    throw new Error("Invalid heartbeat sender");
  }

  const now = Date.now();
  const { trackingEnabled } = await readState();

  // Check page visibility and user activity.
  const eligible =
    trackingEnabled &&
    message.visible === true &&
    message.pageFocused === true &&
    Number.isFinite(message.lastActivityAt) &&
    now - message.lastActivityAt >= 0 &&
    now - message.lastActivityAt < 60000 &&
    await isTabEligible(tabId, platform);

  // Stop counting if the user is inactive,
  // the page is hidden, or the tab isn't eligible.
  if (!eligible) {
    await closeSession(tabId);
    return;
  }

  const { stats, session } = await readState();

  const sameSession =
    session?.tabId === tabId &&
    session?.platform === platform;


  // If another platform/tab had the previous session,
  // close its recoverable interval first.

  if (session && !sameSession) {
    const previousInterval = recoverableInterval(
      session,
      now
    );

    if (previousInterval) {
      addActiveInterval(
        stats,
        session.platform,
        previousInterval.start,
        previousInterval.end
      );
    }
  }


  // Same tab and platform:
  // continue the existing session.
  //
  // This also preserves the session across page refreshes.

  if (sameSession) {
    const interval = recoverableInterval(
      session,
      now
    );

    if (interval) {
      addActiveInterval(
        stats,
        platform,
        interval.start,
        interval.end
      );
    }

    const updatedSession = {
      ...session,
      lastHeartbeatAt: now
    };

    await saveStats(
      stats,
      updatedSession
    );

    return;
  }


  // Different tab or platform:
  // start a fresh session.

  const newSession = {
    tabId,
    platform,
    startedAt: now,
    lastHeartbeatAt: now
  };

  await saveStats(
    stats,
    newSession
  );
}


/* ---------------------------------------------------------
   14. HANDLE DETECTED POSTS
--------------------------------------------------------- */

async function handlePost(message, sender) {
  const {
    platform,
    contentType,
    isSponsored
  } = message;

  if (
    !validPlatform(platform) ||
    !validSender(platform, sender)
  ) {
    throw new Error("Invalid post sender");
  }

  const allowedContentTypes = [
    "text",
    "video",
    "article",
    "image"
  ];

  if (!allowedContentTypes.includes(contentType)) {
    throw new Error("Invalid content type");
  }

  const { stats, trackingEnabled } = await readState();

  if (!trackingEnabled) {
    return stats;
  }

  const dateKey = getLocalDateKey();

  // Create today's record if it doesn't exist.
  stats.daily[dateKey] ||= createDailyRecord();

  // Lifetime platform analytics.
  incrementPlatform(
    stats.platforms[platform],
    contentType,
    Boolean(isSponsored)
  );

  // Daily platform analytics.
  incrementPlatform(
    stats.daily[dateKey].platforms[platform],
    contentType,
    Boolean(isSponsored)
  );

  // Lifetime total.
  stats.totalPosts += 1;

  // Daily total.
  stats.daily[dateKey].totalPosts += 1;

  await saveStats(stats);

  console.log(
    "[BrainWeb] Post detected:",
    platform,
    contentType,
    isSponsored ? "Sponsored" : "Organic"
  );

  return stats;
}


async function setTrackingEnabled(enabled) {
  if (typeof enabled !== "boolean") {
    throw new Error("Tracking state must be a boolean");
  }

  if (!enabled) {
    await closeSession();
  }

  await chrome.storage.local.set({
    trackingEnabled: enabled
  });

  const { stats } = await readState();

  return {
    stats,
    trackingEnabled: enabled
  };
}


async function clearAnalytics() {
  const { trackingEnabled } = await readState();
  const stats = normalizeStats(DEFAULT_STATS);

  await chrome.storage.local.set({
    stats,
    activeSession: null,
    trackingEnabled
  });

  return {
    stats,
    trackingEnabled
  };
}


/* ---------------------------------------------------------
   15. INTERNAL MESSAGE LISTENER
--------------------------------------------------------- */

chrome.runtime.onMessage.addListener(
  (message, sender, sendResponse) => {

    if (!message || typeof message.type !== "string") {
      return;
    }


    // POST DETECTED
    if (message.type === "POST_DETECTED") {
      enqueue(
        () => handlePost(message, sender)
      ).then(
        stats => {
          sendResponse({
            success: true,
            stats
          });
        },

        error => {
          sendResponse({
            success: false,
            error: error.message
          });
        }
      );

      return true;
    }


    // SESSION HEARTBEAT
    if (message.type === "SESSION_HEARTBEAT") {
      enqueue(
        () => handleHeartbeat(message, sender)
      ).then(
        () => {
          sendResponse({
            success: true
          });
        },

        error => {
          sendResponse({
            success: false,
            error: error.message
          });
        }
      );

      return true;
    }


    // SESSION STOP
    if (message.type === "SESSION_STOP") {
      enqueue(
        () => closeSession(sender.tab?.id ?? null)
      ).then(
        () => {
          sendResponse({
            success: true
          });
        },

        error => {
          sendResponse({
            success: false,
            error: error.message
          });
        }
      );

      return true;
    }

    if (message.type === "SET_TRACKING") {
      enqueue(
        () => setTrackingEnabled(message.enabled)
      ).then(
        result => sendResponse({
          success: true,
          ...result
        }),
        error => sendResponse({
          success: false,
          error: error.message
        })
      );

      return true;
    }


    // GET STATS / ANALYTICS
    if (
      message.type === "GET_STATS" ||
      message.type === "GET_ANALYTICS"
    ) {
      enqueue(async () => {
        const { stats, session, trackingEnabled } = await readState();

        return {
          success: true,

          stats,

          daily: stats.daily,

          totalPosts: stats.totalPosts,

          activeSeconds: stats.activeSeconds,

          platforms: stats.platforms,

          activeSession: session,

          trackingEnabled,

          updatedAt: stats.updatedAt
        };

      }).then(
        result => {
          sendResponse(result);
        },

        error => {
          sendResponse({
            success: false,
            error: error.message
          });
        }
      );

      return true;
    }
  }
);


/* ---------------------------------------------------------
   16. BROWSER TAB SWITCHING
--------------------------------------------------------- */

// When the user switches tabs, stop counting the old tab.

chrome.tabs.onActivated.addListener(
  ({ tabId: newTabId }) => {
    enqueue(async () => {
      const { session } = await readState();

      if (
        session &&
        session.tabId !== newTabId
      ) {
        await closeSession(session.tabId);
      }
    });
  }
);


/* ---------------------------------------------------------
   17. BROWSER WINDOW FOCUS
--------------------------------------------------------- */

// When the browser loses focus, stop counting.

chrome.windows.onFocusChanged.addListener(
  windowId => {
    if (windowId === chrome.windows.WINDOW_ID_NONE) {
      enqueue(() => closeSession());
    }
  }
);


/* ---------------------------------------------------------
   18. TAB CLOSED
--------------------------------------------------------- */

chrome.tabs.onRemoved.addListener(
  tabId => {
    enqueue(
      () => closeSession(tabId)
    );
  }
);


/* ---------------------------------------------------------
   19. TAB NAVIGATION
--------------------------------------------------------- */

// If the user navigates away from X or LinkedIn,
// close the session associated with that tab.

chrome.tabs.onUpdated.addListener(
  (tabId, changeInfo) => {
    if (!changeInfo.url) {
      return;
    }

    let hostname;

    try {
      hostname = new URL(changeInfo.url).hostname;
    } catch {
      return;
    }

    const isTrackedPlatform =
      hostname === "x.com" ||
      hostname === "www.linkedin.com";

    if (!isTrackedPlatform) {
      enqueue(
        () => closeSession(tabId)
      );
    }
  }
);


console.log("[BrainWeb] Session manager started.");


/* ---------------------------------------------------------
   20. DASHBOARD EXTERNAL CONNECTION
--------------------------------------------------------- */

importScripts("dashboard-config.js");

const dashboardOrigins = new Set([
  "http://localhost:3000",
  ...(globalThis.BRAINWEB_DASHBOARD_CONFIG.productionDashboardUrl
    ? [new URL(globalThis.BRAINWEB_DASHBOARD_CONFIG.productionDashboardUrl).origin]
    : [])
]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value, keys) {
  return isRecord(value) &&
    Object.keys(value).length === keys.length &&
    keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

chrome.runtime.onMessageExternal.addListener(
  (message, sender, sendResponse) => {

    let senderOrigin;

    try {
      if (typeof sender.url !== "string") {
        throw new Error("Missing sender URL");
      }
      senderOrigin = new URL(sender.url).origin;
    } catch {
      sendResponse({
        success: false,
        error: "Invalid sender"
      });

      return;
    }

    if (!dashboardOrigins.has(senderOrigin)) {
      sendResponse({
        success: false,
        error: "Origin not allowed"
      });

      return;
    }

    if (!isRecord(message) || typeof message.type !== "string") {
      sendResponse({
        success: false,
        error: "Invalid message"
      });

      return;
    }

    if (message.type === "GET_DASHBOARD_STATS") {
      if (!hasExactKeys(message, ["type"])) {
        sendResponse({ success: false, error: "Invalid message" });
        return;
      }

      enqueue(async () => {
        const { stats, session, trackingEnabled } = await readState();

        return {
          success: true,
          stats,
          activeSession: session,
          trackingEnabled,
          updatedAt: stats.updatedAt
        };

      }).then(
        result => {
          sendResponse(result);
        },

        error => {
          sendResponse({
            success: false,
            error: error.message
          });
        }
      );

      return true;
    }

    if (message.type === "SET_TRACKING") {
      if (!hasExactKeys(message, ["type", "enabled"]) ||
          typeof message.enabled !== "boolean") {
        sendResponse({ success: false, error: "Invalid message" });
        return;
      }

      enqueue(
        () => setTrackingEnabled(message.enabled)
      ).then(
        result => sendResponse({
          success: true,
          ...result
        }),
        error => sendResponse({
          success: false,
          error: error.message
        })
      );

      return true;
    }

    if (message.type === "CLEAR_ANALYTICS") {
      if (!hasExactKeys(message, ["type"])) {
        sendResponse({ success: false, error: "Invalid message" });
        return;
      }

      enqueue(clearAnalytics).then(
        result => sendResponse({
          success: true,
          ...result
        }),
        error => sendResponse({
          success: false,
          error: error.message
        })
      );

      return true;
    }


    sendResponse({
      success: false,
      error: "Unsupported message"
    });
  }
);


console.log(
  "[BrainWeb] Dashboard connection listener ready."
);
