// Only run inside our extension iframe
if (!window.name.startsWith("situation-monitor-feed")) {
    // exit silently
    throw new Error("Situation Monitor script terminating for non-extension frame");
}
const EMBED_WHEEL_MESSAGE_TYPE = "situation-monitor-embedded-wheel";
const EMBED_CONTROL_MESSAGE_TYPE = "situation-monitor-embedded-control";
const EMBED_CONTROL_RESULT_MESSAGE_TYPE = "situation-monitor-embedded-control-result";

const ancestorOrigins = Array.from(location.ancestorOrigins || []);
const directParentOrigin = getDirectParentOrigin();
const extensionOrigin = getExtensionOrigin();
const trustedOrigins = new Set([directParentOrigin, extensionOrigin, ...ancestorOrigins].filter(Boolean));
const forwardedControlRequests = new Map();
let customUiRequested = false;
let layoutRefreshFrame = 0;
let layoutObserver = null;
let customUiStyle = null;
let isExplicitlyUnmuted = false;

// Inject aggressive muter into main world to catch Audio objects and pre-roll ads
injectMainWorldMuter();

if (trustedOrigins.size) {
  window.addEventListener("message", handleMessage);
  window.addEventListener("wheel", handleWheel, { passive: true });
  window.addEventListener("DOMContentLoaded", scheduleEmbedLayoutRefresh, { once: true });
  window.addEventListener("load", scheduleEmbedLayoutRefresh, { once: true });
  let lastPauseTime = new WeakMap();

  window.addEventListener("pause", (e) => {
    if (e.target && e.target.tagName && ["VIDEO", "AUDIO"].includes(e.target.tagName.toUpperCase())) {
      lastPauseTime.set(e.target, Date.now());
    }
  }, true);

  window.addEventListener("resize", () => {
    scheduleEmbedLayoutRefresh();
    // Re-trigger play on resize in case the player paused itself during layout switch
    document.querySelectorAll("video, audio").forEach(media => {
      const pauseTime = lastPauseTime.get(media) || 0;
      // If it paused within the last 1.5 seconds (likely due to the resize itself)
      if (media.paused && (Date.now() - pauseTime < 1500)) {
        media.play().catch(() => {});
      }
    });
  });
  
  
  // Constantly force mute in content script world too
  const muteObserver = new MutationObserver(() => {
    document.querySelectorAll("video, audio").forEach(media => {
      if (!isExplicitlyUnmuted) {
        media.muted = true;
      }
      if (!media.dataset.smAutoPlayed) {
        const playPromise = media.play();
        if (playPromise !== undefined) {
          playPromise.then(() => {
            media.dataset.smAutoPlayed = "true";
          }).catch(() => {
            const playBtns = document.querySelectorAll('.play-button, .fp-play, .vjs-big-play-button, .mg-play, [class*="play"], .xplayer-play-overlay, .play-overlay');
            if (playBtns.length) {
              playBtns[0].click();
            } else {
              document.body.click();
              const rect = media.getBoundingClientRect();
              const x = rect.left + rect.width / 2;
              const y = rect.top + rect.height / 2;
              const el = document.elementFromPoint(x, y);
              if (el) el.click();
            }
          });
        }
      }
    });
  });
  muteObserver.observe(document.documentElement || document, { childList: true, subtree: true });
  
  
  window.addEventListener("volumechange", (e) => {
    const userActivated = navigator.userActivation && navigator.userActivation.isActive;
    if (e.isTrusted || userActivated) {
      if (!e.target.muted) {
        isExplicitlyUnmuted = true;
        window.postMessage({ type: "situation-monitor-unmute-signal" }, "*");
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: "situation-monitor-native-unmute" }, "*");
        }
      } else if (e.target.muted) {
        isExplicitlyUnmuted = false;
        window.postMessage({ type: "situation-monitor-mute-signal" }, "*");
        if (window.parent && window.parent !== window) {
          window.parent.postMessage({ type: "situation-monitor-native-mute" }, "*");
        }
      }
    }
  }, true);


}

function injectMainWorldMuter() {
  try {
    const script = document.createElement("script");
    script.textContent = `
      (function() {
        let unmuted = false;
        window.addEventListener("message", (e) => {
          if (e.data && e.data.type === "situation-monitor-unmute-signal") {
            unmuted = true;
          } else if (e.data && e.data.type === "situation-monitor-mute-signal") {
            unmuted = false;
            document.querySelectorAll("video, audio").forEach(m => m.muted = true);
          }
        });
        
        const originalPlay = HTMLMediaElement.prototype.play;
        HTMLMediaElement.prototype.play = function() {
          if (!unmuted) this.muted = true;
          return originalPlay.apply(this, arguments);
        };
        
        const OriginalAudio = window.Audio;
        window.Audio = function() {
          const a = new (Function.prototype.bind.apply(OriginalAudio, [null, ...arguments]));
          if (!unmuted) a.muted = true;
          return a;
        };
        window.Audio.prototype = OriginalAudio.prototype;
        
        
        window.addEventListener("volumechange", (e) => {
          const userActivated = navigator.userActivation && navigator.userActivation.isActive;
          if (e.isTrusted || userActivated) {
            if (!e.target.muted) {
              unmuted = true;
              window.postMessage({ type: "situation-monitor-unmute-signal" }, "*");
            } else if (e.target.muted) {
              unmuted = false;
              window.postMessage({ type: "situation-monitor-mute-signal" }, "*");
            }
          }
        }, true);
        
        setInterval(() => {
          document.querySelectorAll("video, audio").forEach(m => {
            if (!unmuted) m.muted = true;
            if (!m.dataset.smAutoPlayed) {
              const playPromise = m.play();
              if (playPromise !== undefined) {
                playPromise.then(() => {
                  m.dataset.smAutoPlayed = "true";
                }).catch(() => {
                  const playBtns = document.querySelectorAll('.play-button, .fp-play, .vjs-big-play-button, .mg-play, [class*="play"], .xplayer-play-overlay, .play-overlay');
                  if (playBtns.length) {
                    playBtns[0].click();
                  } else {
                    document.body.click();
                    const rect = m.getBoundingClientRect();
                    const x = rect.left + rect.width / 2;
                    const y = rect.top + rect.height / 2;
                    const el = document.elementFromPoint(x, y);
                    if (el) el.click();
                  }
                });
              }
            }
          });
        }, 500);

      })();
    `;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  } catch (err) {
    // Ignore
  }
}

function getDirectParentOrigin() {
  if (document.referrer) {
    try {
      return new URL(document.referrer).origin;
    } catch (error) {
      return "";
    }
  }

  return ancestorOrigins[0] || "";
}

function getExtensionOrigin() {
  if (document.referrer.startsWith("chrome-extension://")) {
    try {
      return new URL(document.referrer).origin;
    } catch (error) {
      return "";
    }
  }

  return ancestorOrigins.find((origin) => origin.startsWith("chrome-extension://")) || "";
}

function handleWheel(event) {
  if (!directParentOrigin || !event.isTrusted || !Number.isFinite(event.deltaY)) {
    return;
  }

  window.parent.postMessage({
    deltaY: event.deltaY,
    type: EMBED_WHEEL_MESSAGE_TYPE
  }, directParentOrigin);
}

function handleMessage(event) {
  const payload = typeof event.data === "object" && event.data ? event.data : null;
  if (!payload || !trustedOrigins.has(event.origin)) {
    return;
  }

  if (payload.type === EMBED_WHEEL_MESSAGE_TYPE) {
    if (directParentOrigin && event.origin !== directParentOrigin) {
      window.parent.postMessage(payload, directParentOrigin);
    }
    return;
  }

  if (payload.type === EMBED_CONTROL_MESSAGE_TYPE) {
    if (payload.customUi) {
      enableCustomUiMode();
    }

    void handleControlMessage(event.origin, payload);
    return;
  }

  if (payload.type === EMBED_CONTROL_RESULT_MESSAGE_TYPE) {
    const pending = forwardedControlRequests.get(payload.requestId);
    if (!pending) {
      return;
    }

    forwardedControlRequests.delete(payload.requestId);
    window.clearTimeout(pending.timer);
    window.parent.postMessage(payload, pending.replyOrigin);
  }
}

function enableCustomUiMode() {
  customUiRequested = true;
  ensureCustomUiStyle();
  ensureLayoutObserver();
  scheduleEmbedLayoutRefresh();
}

function ensureLayoutObserver() {
  if (layoutObserver || !document.documentElement) {
    return;
  }

  layoutObserver = new MutationObserver(() => {
    scheduleEmbedLayoutRefresh();
  });

  layoutObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class", "controls", "src", "style"],
    childList: true,
    subtree: true
  });
}

function ensureCustomUiStyle() {
  if (customUiStyle || !document.documentElement) {
    return;
  }

  customUiStyle = document.createElement("style");
  customUiStyle.id = "situation-monitor-custom-ui";
  customUiStyle.textContent = `
    html,
    body {
      background: transparent !important;
      height: 100% !important;
      margin: 0 !important;
      min-height: 100% !important;
      overflow: hidden !important;
      width: 100% !important;
    }

    body {
      position: relative !important;
    }

    html[data-sm-custom-ui-ready="true"] body > *:not([data-sm-media-tree="true"]) {
      display: none !important;
    }

    [data-sm-media-tree="true"] {
      background: transparent !important;
      border: 0 !important;
      box-shadow: none !important;
      box-sizing: border-box !important;
      height: 100% !important;
      margin: 0 !important;
      max-height: none !important;
      max-width: none !important;
      min-height: 0 !important;
      min-width: 0 !important;
      overflow: hidden !important;
      padding: 0 !important;
      position: relative !important;
      width: 100% !important;
    }

    html[data-sm-custom-ui-ready="true"] [data-sm-media-tree="true"] > *:not([data-sm-media-tree="true"]) {
      display: none !important;
    }

    html[data-sm-custom-ui-ready="true"] iframe[data-sm-primary-media="true"],
    html[data-sm-custom-ui-ready="true"] video[data-sm-primary-media="true"] {
      background: transparent !important;
      border: 0 !important;
      display: block !important;
      height: 100% !important;
      inset: 0 !important;
      margin: 0 !important;
      max-height: none !important;
      max-width: none !important;
      min-height: 0 !important;
      min-width: 0 !important;
      padding: 0 !important;
      position: absolute !important;
      width: 100% !important;
    }

    video[data-sm-primary-media="true"] {
      object-position: center center !important;
    }
  `;

  document.documentElement.append(customUiStyle);
}

function scheduleEmbedLayoutRefresh() {
  if (window !== window.top) {
    document.documentElement.style.overflow = 'hidden';
    document.body.style.margin = '0';
    document.body.style.padding = '0';
    document.body.style.overflow = 'hidden';
    
    // Mute all video and audio elements if not focused...
    // Actually, just try to force mute any video that isn't supposed to have sound.
  }
  if (!customUiRequested) {
    return;
  }

  if (layoutRefreshFrame) {
    window.cancelAnimationFrame(layoutRefreshFrame);
  }

  layoutRefreshFrame = window.requestAnimationFrame(() => {
    layoutRefreshFrame = 0;
    applyEmbedLayoutFixes();
  });
}

function clearMediaTreeMarks() {
  document.documentElement?.removeAttribute("data-sm-custom-ui-ready");

  document.querySelectorAll("[data-sm-media-tree]").forEach((node) => {
    node.removeAttribute("data-sm-media-tree");
  });

  document.querySelectorAll("[data-sm-primary-media]").forEach((node) => {
    node.removeAttribute("data-sm-primary-media");
  });
}

function markPrimaryMediaTree(node) {
  if (!(node instanceof HTMLElement)) {
    return;
  }

  clearMediaTreeMarks();
  document.documentElement.dataset.smCustomUiReady = "true";

  let current = node;
  while (current && current !== document.documentElement) {
    current.dataset.smMediaTree = "true";
    current = current.parentElement;
  }

  node.dataset.smPrimaryMedia = "true";
}

function applyEmbedLayoutFixes() {
  if (!customUiRequested) {
    return;
  }

  ensureCustomUiStyle();

  const primaryMedia = pickPrimaryMediaElement();
  if (!primaryMedia) {
    clearMediaTreeMarks();
    return;
  }

  markPrimaryMediaTree(primaryMedia);

  if (primaryMedia.tagName === "VIDEO") {
    applyNativeUiSuppression(primaryMedia);
  }
}

function getVisibleArea(node) {
  const rect = node.getBoundingClientRect();
  return Math.max(rect.width, 0) * Math.max(rect.height, 0);
}

function pickPrimaryMediaElement() {
  const candidates = Array.from(document.querySelectorAll("video, iframe"))
    .filter((node) => node instanceof HTMLElement)
    .map((node) => ({
      area: getVisibleArea(node),
      isVideo: node.tagName === "VIDEO",
      node
    }))
    .filter((entry) => entry.area > 0);

  if (!candidates.length) {
    return null;
  }

  candidates.sort((left, right) => {
    if (right.area !== left.area) {
      return right.area - left.area;
    }

    if (left.isVideo === right.isVideo) {
      return 0;
    }

    return left.isVideo ? -1 : 1;
  });

  return candidates[0].node;
}

function pickPrimaryVideo() {
  const videos = Array.from(document.querySelectorAll("video"));
  if (!videos.length) {
    return null;
  }

  return videos
    .map((video) => ({
      video,
      visibleArea: getVisibleArea(video)
    }))
    .sort((left, right) => right.visibleArea - left.visibleArea)[0]?.video || null;
}

function applyNativeUiSuppression(video) {
  if (!(video instanceof HTMLVideoElement)) {
    return;
  }

  try {
    video.controls = false;
    video.removeAttribute("controls");
    video.disablePictureInPicture = true;
    video.disableRemotePlayback = true;
    video.playsInline = true;
    video.setAttribute("playsinline", "");
  } catch (error) {
    console.debug("Unable to suppress native video controls", error);
  }

  video.style.objectFit = window.innerHeight > window.innerWidth ? "cover" : "contain";
  video.style.objectPosition = "center center";
}

function getVideoSeekMax(video) {
  if (!(video instanceof HTMLVideoElement)) {
    return 0;
  }

  if (Number.isFinite(video.duration) && video.duration > 0) {
    return video.duration;
  }

  if (!video.seekable?.length) {
    return 0;
  }

  try {
    return video.seekable.end(video.seekable.length - 1);
  } catch (error) {
    return 0;
  }
}

function getVideoState(video) {
  const seekMax = getVideoSeekMax(video);

  return {
    currentTime: Number.isFinite(video.currentTime) ? video.currentTime : 0,
    duration: Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0,
    paused: video.paused,
    seekMax: Number.isFinite(seekMax) && seekMax > 0 ? seekMax : 0
  };
}

async function handleControlMessage(replyOrigin, payload) {
  const localResult = await controlLocalVideo(payload.command, payload.value, {
    customUi: Boolean(payload.customUi)
  });

  if (localResult.success) {
    window.parent.postMessage({
      ...localResult,
      requestId: payload.requestId,
      type: EMBED_CONTROL_RESULT_MESSAGE_TYPE
    }, replyOrigin);
    return;
  }

  const childFrames = Array.from(document.querySelectorAll("iframe")).filter((frame) => frame.contentWindow);
  if (!childFrames.length) {
    window.parent.postMessage({
      requestId: payload.requestId,
      success: false,
      type: EMBED_CONTROL_RESULT_MESSAGE_TYPE
    }, replyOrigin);
    return;
  }

  const timer = window.setTimeout(() => {
    forwardedControlRequests.delete(payload.requestId);
    window.parent.postMessage({
      requestId: payload.requestId,
      success: false,
      type: EMBED_CONTROL_RESULT_MESSAGE_TYPE
    }, replyOrigin);
  }, 1000);

  forwardedControlRequests.set(payload.requestId, { replyOrigin, timer });

  childFrames.forEach((frame) => {
    frame.contentWindow.postMessage(payload, "*");
  });
}

async function controlLocalVideo(command, value, options = {}) {
  const video = pickPrimaryVideo();
  if (!video) {
    if (options.customUi) {
      scheduleEmbedLayoutRefresh();
    }

    return { success: false };
  }

  if (options.customUi) {
    enableCustomUiMode();
    applyNativeUiSuppression(video);
  }

  if (command === "state") {
    return {
      success: true,
      state: getVideoState(video)
    };
  }

  if (command === "pause") {
    video.pause();
    return {
      success: true,
      state: getVideoState(video)
    };
  }

  if (command === "mute") {
    isExplicitlyUnmuted = false;
    window.postMessage({ type: "situation-monitor-mute-signal" }, "*");
    video.muted = true;
    return { success: true, state: getVideoState(video) };
  }

  if (command === "unMute") {
    isExplicitlyUnmuted = true;
    window.postMessage({ type: "situation-monitor-unmute-signal" }, "*");
    video.muted = false;
    return { success: true, state: getVideoState(video) };
  }

  if (command === "seek") {
    const nextTime = Number(value);
    if (!Number.isFinite(nextTime)) {
      return { success: false };
    }

    try {
      const seekMax = getVideoSeekMax(video);
      video.currentTime = Math.max(0, seekMax > 0 ? Math.min(nextTime, seekMax) : nextTime);
    } catch (error) {
      console.debug("Unable to seek embedded video", error);
      return { success: false };
    }

    return {
      success: true,
      state: getVideoState(video)
    };
  }

  if (command === "restart") {
    try {
      if (Number.isFinite(video.duration) && video.duration > 0) {
        video.currentTime = 0;
      } else if (video.seekable?.length) {
        const liveEdge = video.seekable.end(video.seekable.length - 1);
        video.currentTime = Math.max(0, liveEdge - 0.5);
      }
    } catch (error) {
      console.debug("Unable to restart embedded video", error);
    }
  }

  try {
    await video.play();
  } catch (error) {
    return {
      success: false,
      state: getVideoState(video)
    };
  }

  return {
    success: true,
    state: getVideoState(video)
  };
}
