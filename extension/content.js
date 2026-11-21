
(() => {
  const hostname = location.hostname;

  const platform =
    hostname === "x.com" ? "x" :
    hostname === "www.linkedin.com" ? "linkedin" :
    null;

  if (!platform || window.__brainwebTrackerLoaded) return;

  window.__brainwebTrackerLoaded = true;

  // -----------------------------
  // SHARED MESSAGE HELPER
  // -----------------------------

  function sendMessage(message) {
    try {
      if (!chrome.runtime?.id) return;

      chrome.runtime.sendMessage(message).catch(error => {
        console.warn("[BrainWeb] Message failed:", error.message);
      });
    } catch (error) {
      console.warn("[BrainWeb] Extension unavailable:", error.message);
    }
  }

  function isPageActive() {
    return (
      document.visibilityState === "visible" &&
      document.hasFocus()
    );
  }

  // -----------------------------
  // POST TRACKING
  // -----------------------------

  const MIN_VISIBILITY = 0.5;
  const MIN_VISIBLE_MS = 1000;

  const SEEN_STORAGE_KEY = `brainpal.seen.${platform}`;

  function createSessionSalt() {
    const values = new Uint32Array(2);
    crypto.getRandomValues(values);
    return [...values].map(value => value.toString(36)).join("-");
  }

  function loadSessionSeenIds() {
    try {
      const saved = sessionStorage.getItem(SEEN_STORAGE_KEY);

      if (saved) {
        const parsed = JSON.parse(saved);

        if (
          typeof parsed.salt === "string" &&
          Array.isArray(parsed.ids) &&
          parsed.ids.every(id => typeof id === "string")
        ) {
          return {
            salt: parsed.salt,
            ids: new Set(parsed.ids)
          };
        }
      }

      const salt = createSessionSalt();
      sessionStorage.setItem(
        SEEN_STORAGE_KEY,
        JSON.stringify({ salt, ids: [] })
      );

      return { salt, ids: new Set() };
    } catch (error) {
      console.warn("[BrainWeb] Session deduplication storage unavailable:", error.message);
      return {
        salt: `${Date.now()}-${Math.random()}`,
        ids: new Set()
      };
    }
  }

  const sessionSeen = loadSessionSeenIds();
  const seenIds = sessionSeen.ids;
  const observedElements = new WeakSet();
  const counted = new WeakSet();
  const timers = new WeakMap();

  function getAnonymousId(contentId) {
    const value = `${sessionSeen.salt}:${contentId}`;
    let first = 2166136261;
    let second = 2246822519;

    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      first = Math.imul(first ^ code, 16777619);
      second = Math.imul(second ^ code, 3266489917);
    }

    return `${(first >>> 0).toString(16)}${(second >>> 0).toString(16)}`;
  }

  function persistSeenId(id) {
    seenIds.add(id);

    if (seenIds.size > 5000) {
      const recentIds = [...seenIds].slice(-5000);
      seenIds.clear();
      recentIds.forEach(value => seenIds.add(value));
    }

    try {
      sessionStorage.setItem(
        SEEN_STORAGE_KEY,
        JSON.stringify({
          salt: sessionSeen.salt,
          ids: [...seenIds]
        })
      );
    } catch (error) {
      console.warn("[BrainWeb] Could not persist session deduplication:", error.message);
    }
  }

  function getLinkedInFeed() {
    const lists = [...document.querySelectorAll('[role="list"]')];

    return lists
      .filter(list => list.children.length >= 10)
      .sort((a, b) => b.children.length - a.children.length)[0]
      || null;
  }

  function getPosts() {
    if (platform === "x") {
      return [
        ...document.querySelectorAll(
          'article[data-testid="tweet"]'
        )
      ];
    }

    const feed = getLinkedInFeed();

    if (!feed) return [];

    return [...feed.children].flatMap(wrapper => {
      const items = [
        ...wrapper.querySelectorAll('[role="listitem"]')
      ];

      if (items.length !== 1) return [];

      const post = items[0];

      if (!post.querySelector("a, button, video, img")) {
        return [];
      }

      return [post];
    });
  }

  function getContentId(post) {
    if (platform === "x") {
      return post.querySelector('a[href*="/status/"]')
        ?.getAttribute("href") || null;
    }

    return (
      post.getAttribute("data-urn") ||
      post.parentElement?.getAttribute("data-urn") ||
      null
    );
  }

  function isSponsored(post) {
    if (
      post.matches('[data-view-name="feed-ad"], [data-ad-preview]') ||
      post.querySelector('[data-view-name="feed-ad"], [data-ad-preview], [data-testid="placementTracking"]')
    ) {
      return true;
    }

    const labels = platform === "x"
      ? post.querySelectorAll('[data-testid="socialContext"]')
      : post.querySelectorAll(
          '.feed-shared-update-v2__adLabel, .update-components-actor__sub-description'
        );

    return [...labels].some(element =>
      /^(sponsored|promoted)(?:\b|\s*[·•])/i.test(
        (element.textContent || "").trim()
      )
    );
  }

  function classifyPost(post) {
    if (post.querySelector("video")) return "video";

    if (
      post.querySelector(
        '[data-article-id], .update-components-article'
      )
    ) {
      return "article";
    }

    const imageSelectors = platform === "x"
      ? '[data-testid="tweetPhoto"], [data-testid="card.layoutLarge.media"]'
      : ".update-components-image, .feed-shared-image";

    if (post.querySelector(imageSelectors)) return "image";

    return "text";
  }

  function sendCount(post) {
    if (counted.has(post)) return;

    const contentId = getContentId(post);
    const id = contentId ? getAnonymousId(contentId) : null;

    if (id && seenIds.has(id)) return;

    counted.add(post);

    if (id) persistSeenId(id);

    sendMessage({
      type: "POST_DETECTED",
      platform,
      contentType: classifyPost(post),
      isSponsored: isSponsored(post)
    });
  }

  const visibilityObserver = new IntersectionObserver(
    entries => {
      entries.forEach(entry => {
        const post = entry.target;

        const visible =
          entry.isIntersecting &&
          entry.intersectionRatio >= MIN_VISIBILITY &&
          isPageActive();

        if (!visible) {
          clearTimeout(timers.get(post));
          timers.delete(post);
          return;
        }

        if (counted.has(post) || timers.has(post)) return;

        const timer = setTimeout(() => {
          timers.delete(post);

          if (!post.isConnected || !isPageActive()) return;

          const rect = post.getBoundingClientRect();

          const visibleHeight = Math.max(
            0,
            Math.min(rect.bottom, innerHeight) -
            Math.max(rect.top, 0)
          );

          const visibleWidth = Math.max(
            0,
            Math.min(rect.right, innerWidth) -
            Math.max(rect.left, 0)
          );

          const visibleRatio =
            visibleHeight * visibleWidth /
            Math.max(1, rect.width * rect.height);

          if (visibleRatio >= MIN_VISIBILITY) {
            sendCount(post);
          }
        }, MIN_VISIBLE_MS);

        timers.set(post, timer);
      });
    },
    { threshold: [0, 0.5, 0.75] }
  );

  function observePosts() {
    getPosts().forEach(post => {
      if (observedElements.has(post)) return;

      observedElements.add(post);
      visibilityObserver.observe(post);
    });
  }

  observePosts();

  const mutationObserver = new MutationObserver(observePosts);

  mutationObserver.observe(document.body, {
    childList: true,
    subtree: true
  });

  // -----------------------------
  // SESSION MANAGER CLIENT
  // -----------------------------

  const HEARTBEAT_INTERVAL_MS = 10000;
  const IDLE_THRESHOLD_MS = 60000;

  let lastActivityAt = 0;
  let sessionStarted = false;

  function sendHeartbeat() {
    if (!lastActivityAt) return;

    if (
      !isPageActive() ||
      Date.now() - lastActivityAt >= IDLE_THRESHOLD_MS
    ) {
      stopSession();
      return;
    }

    sendMessage({
      type: "SESSION_HEARTBEAT",
      platform,
      visible: document.visibilityState === "visible",
      pageFocused: document.hasFocus(),
      lastActivityAt
    });

    sessionStarted = true;
  }

  function registerActivity() {
    if (!isPageActive()) return;

    lastActivityAt = Date.now();

    if (!sessionStarted) {
      sendHeartbeat();
    }
  }

  function stopSession() {
    if (sessionStarted) {
      sendMessage({
        type: "SESSION_STOP",
        platform
      });
    }

    sessionStarted = false;
  }

  const activityEvents = [
    "scroll",
    "keydown",
    "mousedown",
    "touchstart",
    "pointerdown"
  ];

  activityEvents.forEach(eventName => {
    document.addEventListener(
      eventName,
      registerActivity,
      { passive: true }
    );
  });

  // Throttle mouse movement so it does not generate excessive work.
  let lastMouseActivity = 0;

  document.addEventListener(
    "mousemove",
    () => {
      const now = Date.now();

      if (now - lastMouseActivity < 1000) return;

      lastMouseActivity = now;
      registerActivity();
    },
    { passive: true }
  );

  const heartbeatInterval = setInterval(() => {
    if (!lastActivityAt) return;

    if (Date.now() - lastActivityAt >= IDLE_THRESHOLD_MS) {
      stopSession();
      return;
    }

    if (isPageActive()) {
      sendHeartbeat();
    } else {
      stopSession();
    }
  }, HEARTBEAT_INTERVAL_MS);

  document.addEventListener("visibilitychange", () => {
    if (!isPageActive()) {
      stopSession();

      getPosts().forEach(post => {
        clearTimeout(timers.get(post));
        timers.delete(post);
      });
    }
  });

  window.addEventListener("blur", stopSession);

  window.addEventListener("focus", () => {
    // Require a new user interaction before counting again.
    lastActivityAt = 0;
    stopSession();
  });

  window.addEventListener("pagehide", () => {
    stopSession();

    clearInterval(heartbeatInterval);
    mutationObserver.disconnect();
    visibilityObserver.disconnect();
  });

  console.log(`[BrainWeb] Tracker active: ${platform}`);
})();
