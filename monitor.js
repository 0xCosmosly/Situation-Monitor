window.DISABLE_AUTO_ARRANGE = true;

const MAX_FEEDS = 16;
const FEEDS_KEY = "situation-monitor-feeds";
const SETTINGS_KEY = "situation-monitor-settings";
const PLAYBACK_KEY = "situation-monitor-playback";
const INCOGNITO_STORAGE_SUFFIX = "-incognito";
const INCOGNITO_ENCRYPTION_KEY_KEY = "situation-monitor-incognito-encryption-key";
const DIRECT_VIDEO_PATTERN = /\.(mp4|webm|ogg|m4v|mov)(\?|#|$)/i;
const GRID_GAP = 14;
const TARGET_ASPECT_RATIO = 16 / 9;
const MIN_HORIZONTAL_TILE_WIDTH = 176;
const MIN_HORIZONTAL_TILE_HEIGHT = 99;
const MIN_VERTICAL_TILE_WIDTH = 150;
const MIN_VERTICAL_TILE_HEIGHT = 260;
const TOPBAR_EDGE_REVEAL = 72;
const TOPBAR_HIDE_SCROLL_START = 28;
const TOPBAR_HIDE_SCROLL_DELTA = 10;
const TOPBAR_HIDE_WHEEL_DELTA = 18;
const PLAYBACK_SAVE_DEBOUNCE_MS = 400;
const PLAYBACK_HEALTH_WINDOW_MS = 60_000;
const PLAYBACK_HEALTH_REFRESH_MS = 2_000;
const EMBED_STATE_POLL_MS = 700;
const YOUTUBE_POLL_INTERVAL_MS = 1500;
const EMBED_WHEEL_MESSAGE_TYPE = "situation-monitor-embedded-wheel";
const EMBED_CONTROL_MESSAGE_TYPE = "situation-monitor-embedded-control";
const EMBED_CONTROL_RESULT_MESSAGE_TYPE = "situation-monitor-embedded-control-result";
const EMBEDDED_VIDEO_FRAME_TITLE = "Embedded video";
const EMBED_WHEEL_MESSAGE_ORIGINS = new Set([
  "https://www.youtube.com",
  "https://www.youtube-nocookie.com",
  "https://player.vimeo.com",
  "https://www.dailymotion.com",
  "https://www.loom.com",
  "https://streamable.com",
]);
const YOUTUBE_MESSAGE_ORIGINS = new Set([
  "https://www.youtube.com",
  "https://www.youtube-nocookie.com"
]);
const CUSTOM_CONTROL_PROVIDERS = new Set([
  "vimeo"
]);

const state = {
  clearOnClose: false,
  confirmingClearAll: false,
  editingId: null,
  feeds: [],
  focusId: null,
  panelOpen: false,
  playbackPositions: {},
  topChromeHidden: false,
  unmutedFeeds: new Set()
};

const elements = {
  appShell: document.querySelector(".app-shell"),
  cancelClearAllButton: document.getElementById("cancel-clear-all-button"),
  clearAllButton: document.getElementById("clear-all-button"),
  clearAllTopButton: document.getElementById("clear-all-top-button"),
  clearAllNote: document.getElementById("clear-all-note"),
  clearOnCloseToggle: document.getElementById("clear-on-close-toggle"),
  closePanelButton: document.getElementById("close-panel-button"),
  controlPanel: document.getElementById("control-panel"),
  feedCount: document.getElementById("feed-count"),
  feedCountBreakdown: document.getElementById("feed-count-breakdown"),
  feedForm: document.getElementById("feed-form"),
  feedGrid: document.getElementById("feed-grid"),
  feedId: document.getElementById("feed-id"),
  feedList: document.getElementById("feed-list"),
  feedUrl: document.getElementById("feed-url"),
  feedVertical: document.getElementById("feed-vertical"),
  formHeading: document.getElementById("form-heading"),
  layoutLabel: document.getElementById("layout-label"),
  loadHint: document.getElementById("load-hint"),
  loadValue: document.getElementById("load-value"),
  manageButton: document.getElementById("manage-button"),
  memoryNote: document.getElementById("memory-note"),
  messageBar: document.getElementById("message-bar"),
  panelScrim: document.getElementById("panel-scrim"),
  pauseAllButton: document.getElementById("pause-all-button"),
  resetFormButton: document.getElementById("reset-form-button"),
  restartAllButton: document.getElementById("restart-all-button"),
  saveFeedButton: document.getElementById("save-feed-button"),
  slotRemaining: document.getElementById("slot-remaining"),
  storageHeading: document.getElementById("storage-heading"),
  storageLabel: document.getElementById("storage-label"),
  topChrome: document.getElementById("top-chrome"),
  versionCopy: document.getElementById("version-copy"),
  workspace: document.querySelector(".workspace")
};

let lastScrollY = 0;
let layoutTimer = null;
let messageTimer = null;
let playbackHealthTimer = 0;
let embedStateTimer = 0;
let resizeObserver = null;
let topChromeMeasureFrame = 0;
let verticalDetectionRequestId = 0;
let verticalDetectionTimer = 0;
let topChromeRevealBlockedUntil = 0;

const playbackSaveTimers = new Map();
const embedControlStateByFeed = new Map();
const embedScrubLocks = new Map();
const feedCardCache = new Map();
const playbackHealthByFeed = new Map();
const pendingEmbedCommands = new Map();
const providerEmbedCache = new Map();
const customUiReadyFeeds = new Set();
const youtubeFrames = new Map();
let incognitoCryptoKeyPromise = null;
let embedCommandCounter = 0;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  void hardenStorageAccess();
  bindEvents();
  observeTopChrome();
  startPlaybackHealthRefresh();
  startEmbedStateRefresh();
  renderVersionCopy();
  await migrateLegacyIncognitoSessionStorage();

  const [feeds, settings, playbackPositions] = await Promise.all([
    readFeeds(),
    readSettings(),
    readPlaybackPositions()
  ]);

  state.feeds = feeds;
  state.clearOnClose = settings.clearOnClose;
  state.playbackPositions = playbackPositions;
  state.panelOpen = false;

  render();
  await syncClearOnCloseWithBackground();
  syncTopChromeMetrics();
  lastScrollY = window.scrollY;
}

function bindEvents() {
  const inlineForm = document.getElementById("inline-add-feed-form");
  if (inlineForm) {
    inlineForm.addEventListener("submit", (e) => {
      e.preventDefault();
    e.stopPropagation();
      const input = document.getElementById("inline-feed-url");
      const url = input.value.trim();
      if (url) {
        elements.feedUrl.value = url;
        elements.feedVertical.checked = false;
        elements.feedForm.dispatchEvent(new Event("submit", { cancelable: true, bubbles: true }));
        input.value = "";
      }
    });
  }

  elements.cancelClearAllButton.addEventListener("click", cancelClearAll);
  elements.clearAllButton.addEventListener("click", handleClearAllClick);
  elements.clearAllTopButton.addEventListener("click", handleClearAllClick);
  elements.clearOnCloseToggle.addEventListener("change", handleClearOnCloseToggleChange);
  elements.closePanelButton.addEventListener("click", closePanel);
  elements.feedForm.addEventListener("submit", handleFormSubmit);
  elements.feedUrl.addEventListener("focus", focusFeedUrlField);
  elements.feedUrl.addEventListener("input", handleFeedUrlInput);
  elements.feedUrl.addEventListener("paste", resetFeedUrlFieldScroll);
  elements.feedGrid.addEventListener("click", handleGridClick);
  elements.feedGrid.addEventListener("input", handleGridInput);
  elements.feedList.addEventListener("click", handleListClick);
  elements.manageButton.addEventListener("click", togglePanel);
  elements.panelScrim.addEventListener("click", closePanel);
  elements.pauseAllButton.addEventListener("click", handlePauseAllClick);
  elements.resetFormButton.addEventListener("click", resetForm);
  elements.restartAllButton.addEventListener("click", handleRestartAllClick);
  elements.workspace.addEventListener("click", handleWorkspaceClick);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (state.focusId) {
        closeFocus();
        return;
      }

      if (state.panelOpen) {
        closePanel();
      }
    }
  });

  window.addEventListener("beforeunload", handleBeforeUnload);
  window.addEventListener("mousemove", handleWindowMouseMove);
  window.addEventListener("message", handleEmbeddedPlayerMessage);
  window.addEventListener("resize", handleViewportChange);
  window.addEventListener("wheel", handleWindowWheel, { passive: true });
  window.addEventListener("scroll", handleWindowScroll, { passive: true });
}

function observeTopChrome() {
  if (typeof ResizeObserver === "undefined") {
    return;
  }

  resizeObserver = new ResizeObserver(() => {
    syncTopChromeMetrics();
  });

  resizeObserver.observe(elements.topChrome);
}

function startPlaybackHealthRefresh() {
  if (playbackHealthTimer) {
    return;
  }

  playbackHealthTimer = window.setInterval(() => {
    renderStatus();
  }, PLAYBACK_HEALTH_REFRESH_MS);
}

function startEmbedStateRefresh() {
  if (embedStateTimer) {
    return;
  }

  embedStateTimer = window.setInterval(() => {
    void refreshVisibleEmbedControlState();
  }, EMBED_STATE_POLL_MS);
}

function render() {
  renderPanelState();
  renderTopChromeState();
  renderForm();
  renderMemoryNote();
  renderFeedList();
  renderGrid();
  renderStatus();
  renderClearOnCloseState();
  scheduleTopChromeMeasure();
}

function renderPanelState() {
  document.body.dataset.panelOpen = String(state.panelOpen);
  elements.controlPanel.setAttribute("aria-hidden", String(!state.panelOpen));
  elements.manageButton.setAttribute("aria-expanded", String(state.panelOpen));
  elements.manageButton.textContent = "Manage";
  elements.panelScrim.hidden = !state.panelOpen;
}

function renderTopChromeState() {
  document.body.dataset.topbarHidden = String(state.topChromeHidden);
}

function renderVersionCopy() {
  if (!elements.versionCopy) {
    return;
  }

  const version = typeof chrome !== "undefined" && typeof chrome.runtime?.getManifest === "function"
    ? chrome.runtime.getManifest().version
    : "0.1.0";

  elements.versionCopy.textContent = version ? `Version ${version}` : "";
}

function renderForm() {
  const activeFeed = state.feeds.find((feed) => feed.id === state.editingId);

  elements.feedId.value = activeFeed ? activeFeed.id : "";
  elements.feedUrl.value = activeFeed ? activeFeed.url : "";
  elements.feedVertical.checked = Boolean(activeFeed?.vertical);
  elements.formHeading.textContent = activeFeed ? "Edit feed" : "Add a feed";
  elements.saveFeedButton.textContent = activeFeed ? "Save changes" : "Add video";
  elements.resetFormButton.textContent = activeFeed ? "Remove video" : "Clear";
  resetFeedUrlFieldScroll();
}

function renderFeedList() {
  const slotCapacity = getDynamicSlotCapacity(state.feeds);
  const slotsLeft = slotCapacity - state.feeds.length;

  elements.feedList.innerHTML = "";
  elements.slotRemaining.style.display = "none";
  renderClearAllState();

  if (!state.feeds.length) {
    const emptyCopy = document.createElement("p");
    emptyCopy.className = "empty-list";
    emptyCopy.textContent = "No feeds saved yet. Add your first link and it will appear here.";
    elements.feedList.append(emptyCopy);
    return;
  }

  state.feeds.forEach((feed, index) => {
    const item = document.createElement("article");
    item.className = "feed-list-item";
    item.innerHTML = `
      <div class="list-head">
        <div>
          <p class="list-title">${escapeHtml(feed.title)}</p>
          <p class="list-copy">${escapeHtml(simplifyFeedUrl(feed.url))}${feed.vertical ? "<br>Vertical frame" : ""}</p>
        </div>
      </div>
      <div class="list-actions">
        <button class="button button-ghost" type="button" data-action="move-up" data-feed-id="${feed.id}" ${index === 0 ? "disabled" : ""} aria-label="Move up" style="font-weight: 900; font-size: 16px;">↑</button>
        <button class="button button-ghost" type="button" data-action="move-down" data-feed-id="${feed.id}" ${index === state.feeds.length - 1 ? "disabled" : ""} aria-label="Move down" style="font-weight: 900; font-size: 16px;">↓</button>
        <button class="button button-secondary" type="button" data-action="edit" data-feed-id="${feed.id}">Edit URL</button>
        <button class="button button-danger button-ghost" type="button" data-action="delete" data-feed-id="${feed.id}">Delete</button>
      </div>
    `;

    elements.feedList.append(item);
  });
}

function renderGrid() {
  syncFeedCardCache();
  elements.feedGrid.className = "feed-grid";
  delete elements.feedGrid.dataset.focusOrientation;

  if (!state.feeds.length) {
    elements.feedGrid.replaceChildren(buildEmptyState());
    cleanupDetachedMedia();
    scheduleLayoutRefresh();
    return;
  }

  if (state.focusId && state.feeds.some((feed) => feed.id === state.focusId)) {
    elements.feedGrid.classList.add("feed-grid-focused");
    syncFocusedGridLayout();
    cleanupDetachedMedia();
    scheduleLayoutRefresh();
    void refreshVisibleEmbedControlState();
    return;
  }

  if (state.focusId) {
    state.focusId = null;
  }

  syncStandardGridLayout();

  cleanupDetachedMedia();
  scheduleLayoutRefresh();
  void refreshVisibleEmbedControlState();
}

function buildFocusedLayout() {
  const layout = document.createElement("section");
  layout.className = "focus-layout";

  const main = document.createElement("div");
  main.className = "focus-main";
  layout.append(main);

  const rail = document.createElement("aside");
  rail.className = "focus-rail";
  const railList = document.createElement("div");
  railList.className = "focus-rail-list";
  rail.append(railList);
  layout.append(rail);

  return layout;
}

function syncStandardGridLayout() {
  elements.feedGrid.removeAttribute("data-focus-orientation");

  const emptyState = elements.feedGrid.querySelector(".empty-state");
  if (emptyState) {
    emptyState.remove();
  }

  const feeds = getGridDisplayFeeds();
  feeds.forEach((feed, index) => {
    const card = getFeedCard(feed);
    card.style.order = "";
    card.classList.remove("feed-card-main", "feed-card-rail");
    
    if (window.DISABLE_AUTO_ARRANGE) {
      card.style.order = index;
      if (card.style.position === "absolute" || card.style.position === "relative") {
         card.style.position = "";
         card.style.top = "";
         card.style.left = "";
      }
    } else {
      // Clear any absolute positioning styles we might have added during split mode
      card.style.position = "";
      card.style.top = "";
      card.style.left = "";
      card.style.height = "";
      card.style.width = "";
    }
    
    if (!card.parentNode || card.parentNode !== elements.feedGrid) {
      elements.feedGrid.append(card);
    }
  });
}

function syncFocusedGridLayout() {
  const focusFeed = state.feeds.find((feed) => feed.id === state.focusId);
  if (!focusFeed) {
    syncStandardGridLayout();
    return;
  }

  const emptyState = elements.feedGrid.querySelector(".empty-state");
  if (emptyState) {
    emptyState.remove();
  }

  const feeds = getGridDisplayFeeds();
  feeds.forEach((feed, index) => {
    const isFocus = feed.id === state.focusId;
    const card = getFeedCard(feed, { focusedView: true, rail: !isFocus });
    
    // Clear split mode absolute positioning
    card.style.position = "";
    card.style.top = "";
    card.style.left = "";
    card.style.height = "";
    card.style.width = "";
    
    if (isFocus) {
      card.style.order = -1;
      card.classList.add("feed-card-main");
      card.classList.remove("feed-card-rail");
    } else {
      card.style.order = "";
      card.classList.add("feed-card-rail");
      card.classList.remove("feed-card-main");
    }

    if (!card.parentNode) {
      elements.feedGrid.append(card);
    }
  });

  elements.feedGrid.dataset.focusOrientation = focusFeed.vertical ? "vertical" : "horizontal";
}



function setupDragAndDrop(card, feedId) {
  const dragHandle = document.createElement("div");
  dragHandle.className = "drag-handle";
  dragHandle.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round" class="css-i6dzq1"><circle cx="9" cy="12" r="1"></circle><circle cx="9" cy="5" r="1"></circle><circle cx="9" cy="19" r="1"></circle><circle cx="15" cy="12" r="1"></circle><circle cx="15" cy="5" r="1"></circle><circle cx="15" cy="19" r="1"></circle></svg>';
  card.appendChild(dragHandle);

  let isDragging = false;
  let startX, startY;
  let dragStartX, dragStartY;

  dragHandle.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (e.button !== 0) return;
    
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    
    let rect = card.getBoundingClientRect();
    let gridRect = document.getElementById("feed-grid").getBoundingClientRect();
    
    dragStartX = rect.left - gridRect.left;
    dragStartY = rect.top - gridRect.top;
    
    document.body.classList.add("is-dragging");
    card.classList.add("dragging-live");
    card.style.zIndex = "9999";
    card.style.transition = "none";
    
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragUp);
  });

  function onDragMove(e) {
    if (!isDragging) return;
    
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    
    card.style.left = (dragStartX + dx) + "px";
    card.style.top = (dragStartY + dy) + "px";
    
    const elementsUnderCursor = document.elementsFromPoint(e.clientX, e.clientY);
    const hoveredCard = elementsUnderCursor.find(el => el.classList.contains("feed-card") && el !== card);
    
    if (hoveredCard) {
      const draggedIdx = state.feeds.findIndex(f => f.id === feedId);
      const hoveredIdx = state.feeds.findIndex(f => f.id === hoveredCard.dataset.feedId);
      
      if (draggedIdx !== -1 && hoveredIdx !== -1) {
          const draggedFeed = state.feeds[draggedIdx];
          const hoveredFeed = state.feeds[hoveredIdx];
          
          if (draggedFeed.vertical === hoveredFeed.vertical) {
              state.feeds[draggedIdx] = hoveredFeed;
              state.feeds[hoveredIdx] = draggedFeed;
              applyLayoutMetrics(card);
          }
      }
    }
  }

  function onDragUp(e) {
     if (!isDragging) return;
     isDragging = false;
     window.removeEventListener("pointermove", onDragMove);
     window.removeEventListener("pointerup", onDragUp);
     
     document.body.classList.remove("is-dragging");
     card.classList.remove("dragging-live");
     card.style.zIndex = "";
     card.style.transition = "";
     
     void persistFeeds();
     applyLayoutMetrics();
  }

  const corners = ['nw', 'ne', 'sw', 'se'];
  corners.forEach(dir => {
    const handle = document.createElement("div");
    handle.className = "resize-corner resize-" + dir;
    card.appendChild(handle);
    
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.button !== 0) return;
      
      let startX = e.clientX;
      let startRect = card.getBoundingClientRect();
      
      document.body.classList.add("is-resizing");
      const grid = document.getElementById("feed-grid");
      grid.querySelectorAll("iframe").forEach(ifr => ifr.style.pointerEvents = "none");
      
      const isVertical = card.classList.contains("feed-card-vertical");
      const aspect = isVertical ? (9/16) : (16/9);
      
      function onResizeMove(ev) {
        const deltaX = ev.clientX - startX;
        let deltaW = dir.includes('w') ? -deltaX : deltaX;
        
        let newWidth = startRect.width + deltaW;
        newWidth = Math.max(isVertical ? 150 : 176, newWidth);
        let newHeight = newWidth / aspect;
        
        card.dataset.autoSized = "false";
        
        card.style.width = newWidth + "px";
        card.style.height = newHeight + "px";
        
        applyLayoutMetrics();
      }
      
      function onResizeUp() {
        document.body.classList.remove("is-resizing");
        grid.querySelectorAll("iframe").forEach(ifr => ifr.style.pointerEvents = "");
        window.removeEventListener("pointermove", onResizeMove);
        window.removeEventListener("pointerup", onResizeUp);
        applyLayoutMetrics();
      }
      
      window.addEventListener("pointermove", onResizeMove);
      window.addEventListener("pointerup", onResizeUp);
    });
  });
}


function getFeedCard(feed, options = {}) {
  let cached = feedCardCache.get(feed.id);

  if (!cached || cached.url !== feed.url || cached.vertical !== feed.vertical) {
    if (cached && cached.tile) {
      cached.tile.remove();
    }
    cached = {
      tile: createFeedCard(feed),
      url: feed.url,
      vertical: feed.vertical
    };
    setupDragAndDrop(cached.tile, feed.id);
      feedCardCache.set(feed.id, cached);
    }
  updateFeedCard(cached.tile, feed, options);
  return cached.tile;
}

function createFeedCard(feed) {
  const tile = document.createElement("article");
  tile.dataset.feedId = feed.id;
  if (window.DISABLE_AUTO_ARRANGE) {
    tile.dataset.autoSized = "true";
  }

  const media = buildMediaFrame(feed);
  media.className = "feed-media";

  const overlay = document.createElement("div");
  overlay.className = "feed-overlay";

  const customControls = document.createElement("div");
  customControls.className = "feed-custom-controls";

  tile.append(media);
  tile.append(overlay);
  tile.append(customControls);
  return tile;
}

function updateFeedCard(tile, feed, options = {}) {
  const isFocusedView = Boolean(options.focusedView);
  const source = resolveFeedSource(feed);
  const usesManagedEmbedUi = shouldUseCustomEmbedControls(feed);
  tile.className = "feed-card";
  tile.dataset.feedId = feed.id;
  tile.dataset.embedUi = usesManagedEmbedUi ? "managed" : "native";
  tile.dataset.orientation = feed.vertical ? "vertical" : "horizontal";
  tile.dataset.provider = source.provider;

  if (feed.vertical && !options.rail) {
    tile.classList.add("feed-card-vertical");
  }

  if (isFocusedView) {
    tile.classList.add("feed-card-main");
  }

  if (options.rail) {
    tile.classList.add("feed-card-rail");
  }

  const overlay = tile.querySelector(".feed-overlay");
  const focusAction = isFocusedView ? "clear-focus" : "focus";
  const focusLabel = isFocusedView ? "Grid" : "Focus";
  const orientationAction = feed.vertical ? "set-horizontal" : "set-vertical";
  const orientationLabel = feed.vertical ? "Horizontal" : "Vertical";

  overlay.innerHTML = `
    <div class="feed-actions">
      <button class="button button-secondary" type="button" data-action="${focusAction}" data-feed-id="${feed.id}" style="display: none;">${focusLabel}</button>
      <button class="button button-ghost" type="button" data-action="${orientationAction}" data-feed-id="${feed.id}">${orientationLabel}</button>
      <button class="button button-ghost button-danger" type="button" data-action="remove" data-feed-id="${feed.id}">Remove</button>
    </div>
  `;

  syncFeedCardMedia(tile, feed);
  renderFeedCustomControls(tile, feed);
}

function syncFeedCardMedia(tile, feed) {
  const source = resolveFeedSource(feed);
  const media = tile.querySelector(".feed-media");
  const video = media.querySelector("video");
  const iframe = media.querySelector("iframe");
  const muted = getEffectiveMuted(feed.id);
  const mutedStr = muted ? "true" : "false";

  // Only send mute command if the intended state actually changed (e.g. they clicked Focus)
  // This allows the user to manually unmute the native player without us instantly re-muting them.
  if (tile.dataset.lastMutedState !== mutedStr) {
    tile.dataset.lastMutedState = mutedStr;
    if (video) {
      video.muted = muted;
    } else if (iframe) {
      iframe.title = EMBEDDED_VIDEO_FRAME_TITLE;
      iframe.style.backgroundColor = "transparent";
      
      if (source.provider === "youtube") {
        const frame = findYouTubeFrameByFeedId(feed.id);
        if (frame) {
          sendYouTubeCommand(frame, muted ? "mute" : "unMute", []);
          sendEmbeddedMediaCommand(iframe, muted ? "mute" : "unMute", {}).catch(() => {});
        }
      } else {
        sendEmbeddedMediaCommand(iframe, muted ? "mute" : "unMute", {}).catch(() => {});
      }
    }
  }
}

function shouldUseCustomEmbedControls(feed) {
  const source = resolveFeedSource(feed);
  if (source.provider === "youtube" && feed.vertical) return true;
  return CUSTOM_CONTROL_PROVIDERS.has(source.provider) && source.provider !== "youtube";
}

function shouldActivateCustomEmbedUi(feedOrId) {
  const feedId = typeof feedOrId === "string" ? feedOrId : feedOrId?.id;
  return typeof feedId === "string" && customUiReadyFeeds.has(feedId);
}

function renderFeedCustomControls(tile, feed) {
  const controls = tile.querySelector(".feed-custom-controls");
  if (!controls) {
    return;
  }

  if (!shouldUseCustomEmbedControls(feed)) {
    controls.hidden = true;
    controls.innerHTML = "";
    tile.dataset.customControls = "off";
    return;
  }

  const stateEntry = embedControlStateByFeed.get(feed.id) || null;
  const supported = Boolean(stateEntry?.supported);

  if (!supported) {
    controls.hidden = true;
    controls.innerHTML = "";
    tile.dataset.customControls = "pending";
    return;
  }

  const currentTime = Number.isFinite(stateEntry?.currentTime) ? stateEntry.currentTime : 0;
  const duration = Number.isFinite(stateEntry?.duration) && stateEntry.duration > 0 ? stateEntry.duration : 0;
  const seekMax = Number.isFinite(stateEntry?.seekMax) && stateEntry.seekMax > 0
    ? stateEntry.seekMax
    : duration;
  const value = Math.min(currentTime, seekMax || currentTime || 0);
  const paused = stateEntry?.paused !== false;

  tile.dataset.customControls = "ready";
  controls.hidden = false;
  controls.innerHTML = `
    <button class="feed-control-button" type="button" data-action="toggle-embed-play" data-feed-id="${feed.id}" ${supported ? "" : "disabled"}>
      ${paused ? "Play" : "Pause"}
    </button>
    <button class="feed-control-button" type="button" data-action="toggle-embed-mute" data-feed-id="${feed.id}" ${supported ? "" : "disabled"}>
      ${getEffectiveMuted(feed.id) ? "Unmute" : "Mute"}
    </button>
    <input
      class="feed-control-scrubber"
      type="range"
      min="0"
      max="${seekMax || 1}"
      step="0.1"
      value="${value}"
      data-action="embed-scrub"
      data-feed-id="${feed.id}"
      ${supported && seekMax > 0 ? "" : "disabled"}
      aria-label="Scrub video"
    >
  `;
}

function formatPlaybackClock(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return "0:00";
  }

  const totalSeconds = Math.floor(seconds);
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = totalSeconds % 60;
  return `${minutes}:${String(remainingSeconds).padStart(2, "0")}`;
}

function syncFeedCardCache() {
  const activeIds = new Set(state.feeds.map((feed) => feed.id));

  for (const [feedId, cached] of feedCardCache.entries()) {
    if (!activeIds.has(feedId)) {
      if (cached && cached.tile) {
        cached.tile.remove();
      }
      customUiReadyFeeds.delete(feedId);
      feedCardCache.delete(feedId);
      playbackHealthByFeed.delete(feedId);
    }
  }
}

function renderStatus() {
  document.body.dataset.feedCount = state.feeds.length;
  renderPlaybackHealthStatus();
  
  elements.feedCount.textContent = `${state.feeds.length}`;
  
  if (elements.feedCountBreakdown) {
    const numVertical = state.feeds.filter(f => f.vertical).length;
    const numHorizontal = state.feeds.length - numVertical;
    elements.feedCountBreakdown.innerHTML = `${numHorizontal} horizontal<br>${numVertical} vertical`;
  }

  const storagePath = hasChromeStorage()
    ? getChromeStoragePath()
    : "browser://local-storage/situation-monitor";

  if (elements.storageHeading) {
    elements.storageHeading.textContent = isIncognitoContext()
      ? "Saved in Chrome (Encrypted)"
      : "Saved in Chrome";
  }

  elements.storageLabel.textContent = storagePath;
  elements.storageLabel.title = isIncognitoContext()
    ? `${storagePath}\nSeparate encrypted incognito copy`
    : storagePath;
}

function getGridDisplayFeeds() {
  return [...state.feeds];
}

function renderPlaybackHealthStatus() {
  const metrics = getPlaybackHealthMetrics();
  const loadCard = elements.loadValue.closest(".status-item");

  elements.loadValue.textContent = metrics.value;
  elements.loadHint.textContent = metrics.hint;
  loadCard.dataset.loadState = metrics.state;
}

function getPlaybackHealthMetrics() {
  if (!state.feeds.length) {
    return {
      hint: "Add a few feeds and this will watch buffering time, dropped frames, and startup delay.",
      state: "ok",
      value: "Waiting for feeds"
    };
  }

  const now = Date.now();
  let bufferMs = 0;
  let bufferingNow = 0;
  let droppedFrames = 0;
  let trackedFeeds = 0;
  let totalFrames = 0;
  const startupDelays = [];

  for (const feed of state.feeds) {
    const entry = playbackHealthByFeed.get(feed.id);
    if (!entry) {
      continue;
    }

    trackedFeeds += 1;

    bufferMs += getRecentBufferMs(entry, now);

    if (entry.bufferStartedAt) {
      bufferingNow += 1;
    }

    if (Number.isFinite(entry.droppedFrames) && Number.isFinite(entry.totalFrames)) {
      droppedFrames += entry.droppedFrames;
      totalFrames += entry.totalFrames;
    }

    if (Number.isFinite(entry.startupDelayMs) && entry.startupDelayMs > 0) {
      startupDelays.push(entry.startupDelayMs);
    }
  }

  const droppedPercent = totalFrames > 0 ? droppedFrames / totalFrames * 100 : 0;
  const averageStartupMs = startupDelays.length
    ? startupDelays.reduce((sum, value) => sum + value, 0) / startupDelays.length
    : 0;
  const bufferSeconds = bufferMs / 1000;

  if (!trackedFeeds) {
    return {
      hint: "These players do not expose enough playback detail for a full health reading yet.",
      state: "ok",
      value: "Limited"
    };
  }

  if (bufferingNow > 0 || bufferSeconds >= 4 || droppedPercent >= 4 || averageStartupMs >= 2500) {
    return {
      hint: formatPlaybackHealthHint(bufferSeconds, droppedPercent, averageStartupMs, bufferingNow),
      state: "high",
      value: "Struggling"
    };
  }

  return {
    hint: formatPlaybackHealthHint(bufferSeconds, droppedPercent, averageStartupMs, bufferingNow),
    state: bufferSeconds >= 1.5 || droppedPercent >= 1.5 || averageStartupMs >= 1400 ? "warn" : "ok",
    value: bufferSeconds >= 1.5 || droppedPercent >= 1.5 || averageStartupMs >= 1400 ? "Near limit" : "Good"
  };
}

function formatPlaybackHealthHint(bufferSeconds, droppedPercent, averageStartupMs, bufferingNow) {
  const parts = [
    averageStartupMs > 0 ? `${(averageStartupMs / 1000).toFixed(1)}s startup` : "startup pending",
    `${bufferSeconds.toFixed(1)}s buffering`,
    `${droppedPercent.toFixed(1)}% dropped`
  ];

  if (bufferingNow > 0) {
    parts.push(`${bufferingNow} buffering now`);
  }

  return parts.join("\n");
}

function getPlaybackHealthEntry(feedId, provider = "generic") {
  let entry = playbackHealthByFeed.get(feedId);

  if (!entry) {
    entry = {
      bufferEvents: [],
      bufferStartedAt: 0,
      droppedFrames: 0,
      hasStartedPlaying: false,
      provider,
      startupDelayMs: 0,
      startupStartedAt: 0,
      totalFrames: 0
    };
    playbackHealthByFeed.set(feedId, entry);
  } else if (provider && entry.provider !== provider) {
    entry.provider = provider;
  }

  return entry;
}

function openPlaybackBuffer(feedId, provider = "generic") {
  const entry = getPlaybackHealthEntry(feedId, provider);
  if (entry.bufferStartedAt) {
    return;
  }

  entry.bufferStartedAt = Date.now();
}

function closePlaybackBuffer(feedId) {
  const entry = playbackHealthByFeed.get(feedId);
  if (!entry?.bufferStartedAt) {
    return;
  }

  const finishedAt = Date.now();
  entry.bufferEvents.push({
    endedAt: finishedAt,
    startedAt: entry.bufferStartedAt
  });
  entry.bufferStartedAt = 0;
  prunePlaybackHealthEntries(entry, finishedAt);
}

function getRecentBufferMs(entry, now) {
  prunePlaybackHealthEntries(entry, now);

  const completedMs = entry.bufferEvents.reduce((sum, incident) => {
    return sum + Math.max(0, incident.endedAt - Math.max(incident.startedAt, now - PLAYBACK_HEALTH_WINDOW_MS));
  }, 0);

  if (!entry.bufferStartedAt) {
    return completedMs;
  }

  return completedMs + Math.max(0, now - Math.max(entry.bufferStartedAt, now - PLAYBACK_HEALTH_WINDOW_MS));
}

function prunePlaybackHealthEntries(entry, now) {
  entry.bufferEvents = entry.bufferEvents.filter((incident) => incident.endedAt >= now - PLAYBACK_HEALTH_WINDOW_MS);
}

function captureDirectVideoQuality(video, feedId) {
  if (typeof video.getVideoPlaybackQuality !== "function") {
    return;
  }

  try {
    const quality = video.getVideoPlaybackQuality();
    const entry = getPlaybackHealthEntry(feedId, "video");
    entry.droppedFrames = Number.isFinite(quality.droppedVideoFrames) ? quality.droppedVideoFrames : entry.droppedFrames;
    entry.totalFrames = Number.isFinite(quality.totalVideoFrames) ? quality.totalVideoFrames : entry.totalFrames;
  } catch (error) {
    console.debug("Unable to read direct video quality", error);
  }
}

function getChromeStoragePath() {
  const extensionId = typeof chrome !== "undefined" && chrome.runtime?.id
    ? chrome.runtime.id
    : "extension-id";

  return `~/Library/Application Support/Google/Chrome/Default/Local Extension Settings/${extensionId}/`;
}

function renderClearOnCloseState() {
  elements.clearOnCloseToggle.checked = state.clearOnClose;
}

function renderMemoryNote() {
  if (elements.memoryNote) elements.memoryNote.hidden = true;
}

function renderClearAllState() {
  const hasFeeds = state.feeds.length > 0;
  const isConfirming = state.confirmingClearAll && hasFeeds;
  const scopeLabel = isIncognitoContext() ? "private-window feeds" : "saved feeds";

  elements.clearAllButton.disabled = !hasFeeds;
  elements.clearAllTopButton.disabled = !hasFeeds;
  elements.clearAllButton.className = `button ${isConfirming ? "button-danger" : "button-ghost"}`;
  elements.clearAllTopButton.className = `button ${isConfirming ? "button-danger" : "button-danger"}`;
  elements.clearAllButton.textContent = isConfirming ? "Are you sure?" : "Clear all feeds";
  elements.clearAllTopButton.textContent = isConfirming ? "Are you sure?" : "Clear All";
  elements.cancelClearAllButton.hidden = !isConfirming;
  elements.clearAllNote.hidden = !isConfirming;
  elements.clearAllNote.textContent = isConfirming
    ? `This will remove every ${scopeLabel} and every remembered playback spot in this window mode.`
    : "";
}

function scheduleTopChromeMeasure() {
  if (topChromeMeasureFrame) {
    window.cancelAnimationFrame(topChromeMeasureFrame);
  }

  topChromeMeasureFrame = window.requestAnimationFrame(() => {
    topChromeMeasureFrame = 0;
    syncTopChromeMetrics();
  });
}

function syncTopChromeMetrics() {
  const height = Math.ceil(elements.topChrome.getBoundingClientRect().height);
  document.documentElement.style.setProperty("--top-chrome-height", `${height}px`);
  scheduleLayoutRefresh();
}

function scheduleLayoutRefresh() {
  applyLayoutMetrics();

  if (layoutTimer) {
    window.clearTimeout(layoutTimer);
  }

  layoutTimer = window.setTimeout(() => {
    applyLayoutMetrics();
  }, 250);
}

function applyLayoutMetrics(draggedCard = null) {
  if (!window.DISABLE_AUTO_ARRANGE) return;
  const container = elements.feedGrid;
  let cards = Array.from(container.querySelectorAll(".feed-card"));
  if (!cards.length) return;

  cards.sort((a, b) => {
      let aIdx = state.feeds.findIndex(f => f.id === a.dataset.feedId);
      let bIdx = state.feeds.findIndex(f => f.id === b.dataset.feedId);
      return aIdx - bIdx;
  });

  const topChromeHeight = state.topChromeHidden ? 0 : (document.getElementById("top-chrome")?.clientHeight || 60);
  const containerH = window.innerHeight - topChromeHeight - 48;
  const containerW = container.clientWidth;

  if (state.lastMaxHeightBound && state.lastMaxHeightBound !== containerH && !draggedCard) {
      const ratio = containerH / state.lastMaxHeightBound;
      cards.forEach(card => {
          let currentWidth = parseFloat(card.style.width);
          if (currentWidth && ratio !== 1) {
               let newWidth = currentWidth * ratio;
               const isVertical = card.classList.contains("feed-card-vertical");
               newWidth = Math.max(isVertical ? 150 : 176, newWidth);
               card.style.width = newWidth + "px";
               card.style.height = (newWidth / (isVertical ? 9/16 : 16/9)) + "px";
          }
      });
  }
  if (!draggedCard) state.lastMaxHeightBound = containerH;

  container.style.position = "relative";
  container.style.minHeight = containerH + "px";
  container.style.height = containerH + "px";
  container.style.overflow = "hidden";
  container.style.display = "block";

  const verticals = cards.filter(c => c.classList.contains("feed-card-vertical"));
  const horizontals = cards.filter(c => !c.classList.contains("feed-card-vertical"));

  let vW = 0;
  if (verticals.length > 0) {
      let shouldAutoSizeV = verticals.some(c => !parseFloat(c.style.width)) || verticals.every(c => c.dataset.autoSized === "true");
      
      if (shouldAutoSizeV) {
          let optimalVH = containerH;
          let optimalVW = optimalVH * (9/16);
          if (verticals.length * optimalVW > containerW * 0.5) {
              optimalVW = (containerW * 0.5) / verticals.length;
              optimalVH = optimalVW / (9/16);
          }
          verticals.forEach(c => {
              c.style.width = optimalVW + "px";
              c.style.height = optimalVH + "px";
              c.dataset.autoSized = "true";
          });
      }
      
      let curX = 0;
      verticals.forEach((c) => {
          let cardW = parseFloat(c.style.width) || (containerH * (9/16));
          c.style.position = "absolute";
          
          if (c !== draggedCard) {
              c.style.left = curX + "px";
              c.style.top = "0px";
              c.style.margin = "0px";
              c.style.transform = "translateZ(0)";
          }
          curX += cardW + 12;
      });
      
      if (curX > containerW) {
          let shrinkRatio = containerW / curX;
          curX = 0;
          verticals.forEach(c => {
              let cardW = parseFloat(c.style.width);
              let newW = cardW * shrinkRatio;
              let newH = newW / (9/16);
              c.style.width = newW + "px";
              c.style.height = newH + "px";
              if (c !== draggedCard) {
                  c.style.left = curX + "px";
              }
              curX += newW + 12;
          });
      }
      vW = curX;
  }

  let hAreaW = containerW - vW;
  if (horizontals.length > 0) {
      let numH = horizontals.length;
      let shouldAutoSizeH = horizontals.some(c => !parseFloat(c.style.width)) || horizontals.every(c => c.dataset.autoSized === "true");
      
      if (shouldAutoSizeH) {
          let bestW = 0, bestH = 0;
          for (let cols = 1; cols <= numH; cols++) {
              let rows = Math.ceil(numH / cols);
              let maxW = (hAreaW - (cols - 1) * 12) / cols;
              let maxH = (containerH - (rows - 1) * 12) / rows;
              
              let testW = Math.min(maxW, maxH * (16/9));
              let testH = testW / (16/9);
              
              if (testW > bestW) {
                  bestW = testW;
                  bestH = testH;
              }
          }
          
          horizontals.forEach(c => {
              c.style.width = bestW + "px";
              c.style.height = bestH + "px";
              c.dataset.autoSized = "true";
          });
      }
      
      let curX = vW;
      let curY = 0;
      let rowHeight = 0;
      
      horizontals.forEach((c) => {
          let cardW = parseFloat(c.style.width) || 176;
          let cardH = parseFloat(c.style.height) || (cardW / (16/9));
          
          c.style.position = "absolute";
          
          if (curX + cardW > containerW && curX > vW) {
              curX = vW;
              curY += rowHeight + 12;
              rowHeight = 0;
          }
          
          if (c !== draggedCard) {
              c.style.left = curX + "px";
              c.style.top = curY + "px";
              c.style.margin = "0px";
              c.style.transform = "translateZ(0)";
          }
          
          curX += cardW + 12;
          rowHeight = Math.max(rowHeight, cardH);
      });
  }

  cards.forEach(c => {
      c.style.borderRadius = "16px";
      if (c !== draggedCard) c.style.transform = "translateZ(0)";
      
      if (c.classList.contains("feed-card-vertical")) {
          const iframe = c.querySelector("iframe");
          if (iframe) {
              iframe.style.position = "absolute";
              iframe.style.height = "100%";
              iframe.style.width = "316.05%";
              iframe.style.left = "50%";
              iframe.style.transform = "translateX(-50%)";
              iframe.style.maxWidth = "none";
          }
          const video = c.querySelector("video");
          if (video) video.style.objectFit = "cover";
            } else {
          const iframe = c.querySelector("iframe");
          if (iframe) {
              iframe.style.position = "";
              iframe.style.height = "100%";
              iframe.style.width = "100%";
              iframe.style.left = "";
              iframe.style.transform = "";
              iframe.style.maxWidth = "";
          }
          const video = c.querySelector("video");
          if (video) video.style.objectFit = "contain";
      }
  });

  if (elements.layoutLabel) elements.layoutLabel.textContent = "Manual Flow";
}

function isVerticalStripLayout(feeds) {
  return feeds.length >= 1 && feeds.length <= 4 && feeds.every((feed) => feed.vertical);
}

function getDynamicSlotCapacity(feeds = state.feeds) {
  if (!feeds.length) {
    return MAX_FEEDS;
  }

  const sampleFeeds = feeds.slice(0, MAX_FEEDS);
  let capacity = 0;

  for (let count = 1; count <= MAX_FEEDS; count += 1) {
    const projectedFeeds = Array.from({ length: count }, (_, index) => sampleFeeds[index % sampleFeeds.length]);
    const layout = getBestLayout(projectedFeeds);

    if (layout.overflow === 0 && meetsTileSizeFloor(projectedFeeds, layout)) {
      capacity = count;
    }
  }

  return Math.max(capacity, 1);
}

function meetsTileSizeFloor(feeds, layout) {
  if (!layout.tileWidth || layout.tileWidth <= 0) {
    return false;
  }

  return feeds.every((feed) => {
    const aspectRatio = getGridAspectRatio(feed);
    const tileWidth = layout.tileWidth;
    const tileHeight = tileWidth / aspectRatio;

    if (feed.vertical) {
      return tileWidth >= MIN_VERTICAL_TILE_WIDTH && tileHeight >= MIN_VERTICAL_TILE_HEIGHT;
    }

    return tileWidth >= MIN_HORIZONTAL_TILE_WIDTH && tileHeight >= MIN_HORIZONTAL_TILE_HEIGHT;
  });
}

function getBestLayout(feeds, overrideWidth, overrideHeight) {
  const feedCount = feeds.length;
  const safeClientWidth = document.documentElement.clientWidth || window.innerWidth;
  const hPadding = state.topChromeHidden ? 16 : getShellPadding() * 2;
  const availableWidth = overrideWidth !== undefined ? overrideWidth : Math.max(elements.feedGrid.clientWidth, safeClientWidth - hPadding);
  const availableHeight = overrideHeight !== undefined ? overrideHeight : Math.max(getAvailableGridHeight(), 220);
  let bestChoice = {
    area: 0,
    columns: 1,
    columnWidth: null,
    maxWidth: availableWidth,
    overflow: Number.POSITIVE_INFINITY,
    tileWidth: 0,
    rows: feedCount
  };

  if (isVerticalStripLayout(feeds)) {
    const columns = feedCount;
    const widthPerTile = (availableWidth - GRID_GAP * (columns - 1)) / columns;
    const tileWidth = Math.min(widthPerTile, availableHeight * (9 / 16));
    const maxWidth = Math.min(availableWidth, tileWidth * columns + GRID_GAP * (columns - 1));

    return {
      area: tileWidth * (tileWidth / (9 / 16)),
      columns,
      columnWidth: tileWidth,
      maxWidth,
      overflow: 0,
      tileWidth,
      rows: 1
    };
  }

  const averageAspectRatio = feeds.reduce((sum, feed) => sum + getGridAspectRatio(feed), 0) / feedCount;
  const maxAllowedColumns = averageAspectRatio < 1 ? Math.min(4, feedCount) : Math.min(feedCount, MAX_FEEDS);

  for (let columns = 1; columns <= maxAllowedColumns; columns += 1) {
    const rows = Math.ceil(feedCount / columns);
    const widthPerTile = (availableWidth - GRID_GAP * (columns - 1)) / columns;
    const heightBudget = availableHeight - GRID_GAP * (rows - 1);

    if (widthPerTile <= 0 || heightBudget <= 0) {
      continue;
    }

    let rowHeightFactor = 0;
    for (let rowIndex = 0; rowIndex < rows; rowIndex += 1) {
      const rowFeeds = feeds.slice(rowIndex * columns, rowIndex * columns + columns);
      const rowFactor = rowFeeds.reduce((maxFactor, feed) => {
        const aspectRatio = getGridAspectRatio(feed);
        return Math.max(maxFactor, 1 / aspectRatio);
      }, 1 / TARGET_ASPECT_RATIO);
      rowHeightFactor += rowFactor;
    }

    const tileWidth = Math.min(widthPerTile, heightBudget / rowHeightFactor);

    if (tileWidth <= 0) {
      continue;
    }

    const totalHeight = tileWidth * rowHeightFactor + GRID_GAP * (rows - 1);
    const overflow = Math.max(totalHeight - availableHeight, 0);
    const area = tileWidth * (tileWidth / averageAspectRatio);
    const maxWidth = Math.min(availableWidth, tileWidth * columns + GRID_GAP * (columns - 1));
    const fits = overflow === 0;
    const bestFits = bestChoice.overflow === 0;
    const hasLargerArea = area > bestChoice.area + 1;
    const hasLessOverflow = overflow < bestChoice.overflow - 1;
    const similarArea = Math.abs(area - bestChoice.area) <= 1;

    if (
      (fits && !bestFits) ||
      (fits === bestFits && hasLargerArea) ||
      (fits === bestFits && similarArea && hasLessOverflow) ||
      (fits === bestFits && similarArea && Math.abs(overflow - bestChoice.overflow) <= 1 && columns < bestChoice.columns)
    ) {
      bestChoice = {
        area,
        columns,
        columnWidth: tileWidth,
        maxWidth,
        overflow,
        tileWidth,
        rows
      };
    }
  }

  return bestChoice;
}

function getGridAspectRatio(feed) {
  return feed?.vertical ? 9 / 16 : TARGET_ASPECT_RATIO;
}

function getAvailableGridHeight() {
  const gridTop = elements.feedGrid.getBoundingClientRect().top;
  const topInset = getVisibleViewportTopInset();
  const rawHeight = window.innerHeight - Math.max(gridTop, topInset) - getViewportBottomPadding();
  return state.topChromeHidden ? Math.max(rawHeight, window.innerHeight - 16) : rawHeight;
}

function getVisibleViewportTopInset() {
  if (state.topChromeHidden) {
    return 8;
  }

  const shellPadding = getShellPadding();
  return Math.max(shellPadding, Math.ceil(elements.topChrome.getBoundingClientRect().bottom + 12));
}

function getViewportBottomPadding() {
  const shellStyles = window.getComputedStyle(elements.appShell);
  return parseFloat(shellStyles.paddingBottom) || getShellPadding();
}

function getShellPadding() {
  const rootStyles = window.getComputedStyle(document.documentElement);
  return parseFloat(rootStyles.getPropertyValue("--shell-padding")) || 18;
}

function buildEmptyState() {
  const section = document.createElement("section");
  section.className = "empty-state";
  section.innerHTML = `
    <div>
      <h2>One page, unlimited videos</h2>
    </div>
    <p>Paste a video link and the extension will try to auto-arrange the best fit in the current visible tab area.<br><br>Regular Chrome windows share one feed list and one set of remembered playback spots.</p>
    <div class="empty-state-list">
      <div class="empty-state-item">
        <span class="empty-state-number">1</span>
        <p>Paste a feed link and save it.</p>
      </div>
      <div class="empty-state-item">
        <span class="empty-state-number">2</span>
        <p>Repeat until your screen has the mix of feeds you want. The layout adjusts itself automatically.</p>
      </div>

    </div>
  `;
  return section;
}

function buildMediaFrame(feed) {
  const source = resolveFeedSource(feed);
  const wrapper = document.createElement("div");
  const muted = getEffectiveMuted(feed.id);
  wrapper.dataset.provider = source.provider;
  if (source.isNativeVertical) {
    wrapper.dataset.nativeVertical = "true";
  }

  if (source.kind === "video") {
    const video = document.createElement("video");
    video.autoplay = true;
    video.controls = true;
    video.loop = true;
    video.muted = muted;
    video.playsInline = true;
    video.preload = "metadata";
    video.src = source.src;
    bindDirectVideoState(video, feed.id);
    wrapper.append(video);

    return wrapper;
  }

  const iframe = document.createElement("iframe");
  iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; fullscreen; gyroscope; picture-in-picture; web-share";
  iframe.allowFullscreen = true;
  iframe.setAttribute("allowtransparency", "true");
  iframe.setAttribute("scrolling", "no");
  iframe.loading = "lazy";
  iframe.width = "100%";
  iframe.height = "100%";
  iframe.dataset.feedId = feed.id;
  iframe.name = "situation-monitor-feed-" + feed.id;
  iframe.dataset.provider = source.provider;
  iframe.dataset.sourceBaseUrl = source.baseUrl;
  iframe.src = buildEmbeddedUrl(source, feed, muted);
  iframe.style.backgroundColor = "transparent";
  iframe.title = EMBEDDED_VIDEO_FRAME_TITLE;

  iframe.addEventListener("load", () => {
    sendEmbeddedMediaCommand(iframe, getEffectiveMuted(feed.id) ? "mute" : "unMute", {}).catch(() => {});
    if (!shouldUseCustomEmbedControls(feed)) {
      return;
    }

    void syncEmbedControlState(feed, iframe);
  });

  if (source.provider === "youtube") {
    registerYouTubeFrame(iframe, feed.id);
  }

  wrapper.append(iframe);

  return wrapper;
}

function bindDirectVideoState(video, feedId) {
  const entry = getPlaybackHealthEntry(feedId, "video");
  entry.startupStartedAt = performance.now();
  entry.startupDelayMs = 0;

  video.addEventListener("loadedmetadata", () => {
    restoreDirectVideoPosition(video, feedId);
  }, { once: true });

  const persistTime = () => {
    queuePlaybackPositionSave(feedId, video.currentTime);
    captureDirectVideoQuality(video, feedId);
  };

  video.addEventListener("loadstart", () => {
    const directEntry = getPlaybackHealthEntry(feedId, "video");
    directEntry.startupStartedAt = performance.now();
    directEntry.startupDelayMs = 0;
    directEntry.hasStartedPlaying = false;
  });
  video.addEventListener("waiting", () => {
    openPlaybackBuffer(feedId, "video");
  });
  video.addEventListener("stalled", () => {
    openPlaybackBuffer(feedId, "video");
  });
  video.addEventListener("canplay", () => {
    closePlaybackBuffer(feedId);
  });
  video.addEventListener("playing", () => {
    const directEntry = getPlaybackHealthEntry(feedId, "video");
    if (!directEntry.hasStartedPlaying && directEntry.startupStartedAt) {
      directEntry.startupDelayMs = Math.max(0, performance.now() - directEntry.startupStartedAt);
      directEntry.hasStartedPlaying = true;
    }

    closePlaybackBuffer(feedId);
    captureDirectVideoQuality(video, feedId);
    renderStatus();
  });
  video.addEventListener("timeupdate", persistTime);
  video.addEventListener("pause", () => {
    closePlaybackBuffer(feedId);
    persistTime();
  });
  video.addEventListener("ended", () => {
    closePlaybackBuffer(feedId);
    queuePlaybackPositionSave(feedId, 0);
    renderStatus();
  });
}

function restoreDirectVideoPosition(video, feedId) {
  const savedTime = getSavedPlaybackPosition(feedId);
  if (!savedTime) {
    return;
  }

  const clampedTime = clampPlaybackTime(savedTime, video.duration);

  if (clampedTime <= 0) {
    return;
  }

  try {
    video.currentTime = clampedTime;
  } catch (error) {
    console.debug("Unable to restore direct video position", error);
  }
}

function registerYouTubeFrame(iframe, feedId) {
  const key = `youtube_${feedId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const frame = {
    feedId,
    hasRestored: false,
    iframe,
    key,
    origin: "",
    pollTimer: null
  };
  const entry = getPlaybackHealthEntry(feedId, "youtube");
  entry.startupStartedAt = performance.now();
  entry.startupDelayMs = 0;
  entry.hasStartedPlaying = false;

  iframe.dataset.youtubeKey = key;
  youtubeFrames.set(key, frame);

  iframe.addEventListener("load", () => {
    if (!youtubeFrames.has(key)) {
      return;
    }

    try {
      frame.origin = new URL(iframe.src).origin;
    } catch (error) {
      frame.origin = "https://www.youtube-nocookie.com";
    }

    startYouTubeBridge(frame);
  }, { once: true });
}

function startYouTubeBridge(frame) {
  sendYouTubeCommand(frame, "addEventListener", ["onStateChange"]);
  sendYouTubeListeningMessage(frame);
  window.setTimeout(() => {
    if (youtubeFrames.has(frame.key)) {
      sendYouTubeCommand(frame, "addEventListener", ["onStateChange"]);
      sendYouTubeListeningMessage(frame);
      maybeRestoreYouTubePosition(frame);
    }
  }, 700);

  frame.pollTimer = window.setInterval(() => {
    if (!document.body.contains(frame.iframe)) {
      cleanupDetachedMedia();
      return;
    }

    sendYouTubeCommand(frame, "getCurrentTime", []);
  }, YOUTUBE_POLL_INTERVAL_MS);
}

function sendYouTubeListeningMessage(frame) {
  if (!frame.iframe.contentWindow) {
    return;
  }

  frame.iframe.contentWindow.postMessage(JSON.stringify({
    channel: "widget",
    event: "listening",
    id: frame.key
  }), frame.origin || "*");
}

function sendYouTubeCommand(frame, func, args = []) {
  if (!frame.iframe.contentWindow) {
    return;
  }

  frame.iframe.contentWindow.postMessage(JSON.stringify({
    channel: "widget",
    event: "command",
    func,
    args,
    id: frame.key
  }), frame.origin || "*");
}

function maybeRestoreYouTubePosition(frame) {
  if (frame.hasRestored) {
    return;
  }

  const savedTime = getSavedPlaybackPosition(frame.feedId);
  frame.hasRestored = true;

  if (!savedTime) {
    return;
  }

  sendYouTubeCommand(frame, "seekTo", [savedTime, true]);

  window.setTimeout(() => {
    if (youtubeFrames.has(frame.key)) {
      sendYouTubeCommand(frame, "seekTo", [savedTime, true]);
    }
  }, 900);
}

function cleanupDetachedMedia() {
  for (const [key, frame] of youtubeFrames.entries()) {
    if (document.body.contains(frame.iframe)) {
      continue;
    }

    if (frame.pollTimer) {
      window.clearInterval(frame.pollTimer);
    }

    youtubeFrames.delete(key);
  }
}

function buildEmbeddedUrl(source, feed, muted) {
  const showControls = (source.provider === "youtube" && feed.vertical) ? "0" : "1"; // Hide native controls if vertical, show if horizontal

  if (source.provider === "youtube") {    const params = new URLSearchParams({
      autoplay: "1",
      cc_load_policy: "0",
      controls: showControls,
      enablejsapi: "1",
      iv_load_policy: "3",
      modestbranding: "1",
      mute: muted ? "1" : "0",
      playsinline: "1",
      rel: "0",
      origin: (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.id) ? `chrome-extension://${chrome.runtime.id}` : (window.location.origin && window.location.origin !== "null" && !window.location.origin.startsWith("file://") ? window.location.origin : "https://situation-monitor.local")
    });

    const savedTime = getSavedPlaybackPosition(feed.id);
    if (savedTime > 0) {
      params.set("start", String(savedTime));
    }

    return `${source.baseUrl}?${params.toString()}`;
  }

  if (source.provider === "vimeo") {
    return `${source.baseUrl}?autoplay=1&loop=1&muted=${muted ? 1 : 0}&title=0&byline=0&portrait=0&controls=${showControls}`;
  }

  if (source.provider === "dailymotion") {
    return `${source.baseUrl}?autoplay=1&loop=1&mute=${muted ? 1 : 0}&controls=${showControls === "1" ? "true" : "false"}`;
  }

  try {
    const parsed = new URL(source.baseUrl);
    if (!parsed.searchParams.has("autoplay")) parsed.searchParams.set("autoplay", "1");
    if (!parsed.searchParams.has("loop")) parsed.searchParams.set("loop", "1");
    if (!parsed.searchParams.has("mute")) parsed.searchParams.set("mute", muted ? "1" : "0");
    if (!parsed.searchParams.has("muted")) parsed.searchParams.set("muted", muted ? "1" : "0");
    if (!parsed.searchParams.has("playsinline")) parsed.searchParams.set("playsinline", "1");
    return parsed.toString();
  } catch (err) {
    return source.baseUrl;
  }
}

function appendReloadToken(rawUrl, token) {
  try {
    const url = new URL(rawUrl);
    url.searchParams.set("sm_restart", String(token));
    return url.toString();
  } catch (error) {
    const separator = rawUrl.includes("?") ? "&" : "?";
    return `${rawUrl}${separator}sm_restart=${encodeURIComponent(String(token))}`;
  }
}

async function syncIframeElementSource(iframe, source, feed, muted, options = {}) {
  const nextUrl = buildEmbeddedUrl(source, feed, muted);
  const targetUrl = options.forceReload
    ? appendReloadToken(nextUrl, options.token ?? Date.now())
    : nextUrl;

  if (options.forceReload) {
    iframe.src = "about:blank";
    await new Promise((resolve) => {
      window.requestAnimationFrame(resolve);
    });
  }

  if (options.forceReload || iframe.src !== targetUrl) {
    iframe.src = targetUrl;
  }

  return targetUrl;
}

function waitForIframeLoad(iframe, timeoutMs = 1200) {
  return new Promise((resolve) => {
    let settled = false;

    const finish = () => {
      if (settled) {
        return;
      }

      settled = true;
      window.clearTimeout(timer);
      iframe.removeEventListener("load", finish);
      resolve();
    };

    const timer = window.setTimeout(finish, timeoutMs);
    iframe.addEventListener("load", finish, { once: true });
  });
}

function getIframeOrigin(iframe) {
  try {
    return new URL(iframe.src).origin;
  } catch (error) {
    return "";
  }
}

function resolvePendingEmbedCommand(requestId, payload) {
  const pending = pendingEmbedCommands.get(requestId);
  if (!pending) {
    return;
  }

  window.clearTimeout(pending.timer);
  pendingEmbedCommands.delete(requestId);
  pending.resolve(payload);
}

function sendEmbeddedMediaCommand(iframe, command, options = {}) {
  if (!iframe?.contentWindow) {
    return Promise.resolve({ success: false });
  }

  const origin = getIframeOrigin(iframe);
  // Allow all origins since bridge is injected everywhere
  if (!origin) {
    return Promise.resolve({ success: false });
  }

  const requestId = `${command}_${Date.now()}_${embedCommandCounter += 1}`;
  const timeoutMs = options.timeoutMs ?? 550;

  return new Promise((resolve) => {
    const timer = window.setTimeout(() => {
      pendingEmbedCommands.delete(requestId);
      resolve({ requestId, success: false, type: EMBED_CONTROL_RESULT_MESSAGE_TYPE });
    }, timeoutMs);

    pendingEmbedCommands.set(requestId, { resolve, timer });
    iframe.contentWindow.postMessage({
      command,
      customUi: Boolean(options.customUi),
      value: options.value,
      requestId,
      type: EMBED_CONTROL_MESSAGE_TYPE
    }, origin);
  });
}

async function refreshVisibleEmbedControlState() {
  const tasks = [];

  document.querySelectorAll(".feed-card iframe").forEach((iframe) => {
    const feedId = iframe.closest(".feed-card")?.dataset.feedId || "";
    const feed = feedId ? state.feeds.find((item) => item.id === feedId) : null;
    if (!feed || !shouldUseCustomEmbedControls(feed)) {
      return;
    }

    const lockUntil = embedScrubLocks.get(feedId) || 0;
    if (lockUntil > performance.now()) {
      return;
    }

    tasks.push(syncEmbedControlState(feed, iframe));
  });

  if (tasks.length) {
    await Promise.allSettled(tasks);
  }
}

async function syncEmbedControlState(feed, iframe) {
  const response = await sendEmbeddedMediaCommand(iframe, "state", {
    customUi: shouldActivateCustomEmbedUi(feed),
    feedId: feed.id,
    timeoutMs: 800
  });

  applyEmbedControlState(feed.id, response);
}

function applyEmbedControlState(feedId, response) {
  const previousState = embedControlStateByFeed.get(feedId) || null;
  const nextState = response?.success && response.state
    ? {
      currentTime: Number(response.state.currentTime) || 0,
      duration: Number(response.state.duration) || 0,
      paused: Boolean(response.state.paused),
      seekMax: Number(response.state.seekMax) || 0,
      supported: true
    }
    : previousState?.supported
      ? previousState
      : { supported: false };

  embedControlStateByFeed.set(feedId, nextState);

  if (nextState.supported) {
    customUiReadyFeeds.add(feedId);
  } else if (!previousState?.supported) {
    customUiReadyFeeds.delete(feedId);
  }

  if (nextState.supported && Number.isFinite(nextState.currentTime)) {
    queuePlaybackPositionSave(feedId, nextState.currentTime);
  }

  const feed = state.feeds.find((item) => item.id === feedId);
  const tile = elements.feedGrid.querySelector(`.feed-card[data-feed-id="${CSS.escape(feedId)}"]`);
  if (feed && tile) {
    renderFeedCustomControls(tile, feed);
  }
}

async function toggleEmbeddedPlayback(feedId) {
  const tile = elements.feedGrid.querySelector(`.feed-card[data-feed-id="${CSS.escape(feedId)}"]`);
  const iframe = tile?.querySelector("iframe");
  if (!iframe) {
    return;
  }

  const currentState = embedControlStateByFeed.get(feedId);
  const command = currentState?.paused === false ? "pause" : "play";
  const response = await sendEmbeddedMediaCommand(iframe, command, {
    customUi: shouldActivateCustomEmbedUi(feedId),
    feedId,
    timeoutMs: 900
  });

  applyEmbedControlState(feedId, response);
}

function handleGridInput(event) {
  const target = event.target.closest("[data-action]");
  if (!target) {
    return;
  }

  if (target.dataset.action !== "embed-scrub") {
    return;
  }

  const feedId = target.dataset.feedId || "";
  const seconds = Number(target.value);
  if (!feedId || !Number.isFinite(seconds)) {
    return;
  }

  embedScrubLocks.set(feedId, performance.now() + 1200);

  const existingState = embedControlStateByFeed.get(feedId) || { supported: true };
  embedControlStateByFeed.set(feedId, {
    ...existingState,
    currentTime: seconds,
    supported: true
  });

  const feed = state.feeds.find((item) => item.id === feedId);
  const tile = elements.feedGrid.querySelector(`.feed-card[data-feed-id="${CSS.escape(feedId)}"]`);
  if (feed && tile) {
    renderFeedCustomControls(tile, feed);
  }

  const iframe = tile?.querySelector("iframe");
  if (!iframe) {
    return;
  }

  void sendEmbeddedMediaCommand(iframe, "seek", {
    customUi: shouldActivateCustomEmbedUi(feedId),
    feedId,
    timeoutMs: 900,
    value: seconds
  }).then((response) => {
    applyEmbedControlState(feedId, response);
  });
}

async function resumeVisibleMedia(options = {}) {
  const targetFeedId = options.feedId || "";
  const playPromises = [];
  const iframeCommands = [];

  document.querySelectorAll(".feed-card video").forEach((video) => {
    const feedId = video.closest(".feed-card")?.dataset.feedId || "";
    if (targetFeedId && feedId !== targetFeedId) {
      return;
    }

    const maybePromise = video.play();
    if (maybePromise?.catch) {
      playPromises.push(maybePromise.catch(() => {}));
    }
  });

  for (const frame of youtubeFrames.values()) {
    if (targetFeedId && frame.feedId !== targetFeedId) {
      continue;
    }

    sendYouTubeCommand(frame, "playVideo", []);
  }

  document.querySelectorAll(".feed-card iframe").forEach((iframe) => {
    const feedId = iframe.closest(".feed-card")?.dataset.feedId || "";
    const feed = state.feeds.find((item) => item.id === feedId);
    if (targetFeedId && feedId !== targetFeedId) {
      return;
    }

    if (iframe.src.includes("youtube-nocookie.com/embed/") || iframe.src.includes("youtube.com/embed/")) {
      return;
    }

    iframeCommands.push(sendEmbeddedMediaCommand(iframe, "play", {
      customUi: Boolean(feed && shouldActivateCustomEmbedUi(feed))
    }));
  });

  if (playPromises.length) {
    await Promise.allSettled(playPromises);
  }

  if (iframeCommands.length) {
    await Promise.allSettled(iframeCommands);
  }
}

function resolveFeedSource(feed) {
  const url = feed.url.trim();

  const youtubeId = extractYouTubeId(url);
  if (youtubeId) {
    const isShort = url.includes("/shorts/");
    return {
      baseUrl: `https://www.youtube-nocookie.com/embed/${youtubeId}`,
      kind: "iframe",
      provider: "youtube",
      isNativeVertical: isShort
    };
  }

  const vimeoId = extractVimeoId(url);
  if (vimeoId) {
    return {
      baseUrl: `https://player.vimeo.com/video/${vimeoId}`,
      kind: "iframe",
      provider: "vimeo"
    };
  }

  const dailymotionId = extractDailymotionId(url);
  if (dailymotionId) {
    return {
      baseUrl: `https://www.dailymotion.com/embed/video/${dailymotionId}`,
      kind: "iframe",
      provider: "dailymotion"
    };
  }

  const loomId = extractLoomId(url);
  if (loomId) {
    return {
      baseUrl: `https://www.loom.com/embed/${loomId}`,
      kind: "iframe",
      provider: "loom"
    };
  }

  const streamableId = extractStreamableId(url);
  if (streamableId) {
    return {
      baseUrl: `https://streamable.com/e/${streamableId}`,
      kind: "iframe",
      provider: "streamable"
    };
  }


  if (DIRECT_VIDEO_PATTERN.test(url)) {
    return {
      baseUrl: url,
      kind: "video",
      provider: "video",
      src: url
    };
  }

  return {
    baseUrl: url,
    kind: "iframe",
    provider: "generic"
  };
}

function getEffectiveMuted(feedId) {
  if (state.unmutedFeeds.has(feedId)) return false;
  return !state.focusId || state.focusId !== feedId;
}

function resetFeedUrlFieldScroll() {
  const keepUrlFieldAnchored = () => {
    elements.feedUrl.scrollLeft = 0;
  };

  keepUrlFieldAnchored();
  window.requestAnimationFrame(keepUrlFieldAnchored);
  window.setTimeout(keepUrlFieldAnchored, 0);
  window.setTimeout(keepUrlFieldAnchored, 50);
}

function focusFeedUrlField() {
  resetFeedUrlFieldScroll();

  window.requestAnimationFrame(() => {
    try {
      elements.feedUrl.setSelectionRange(0, 0);
    } catch (error) {
      // Ignore selection failures for unsupported input states.
    }

    elements.feedUrl.scrollLeft = 0;
  });
}

function handleFeedUrlInput() {
  resetFeedUrlFieldScroll();

  if (verticalDetectionTimer) {
    window.clearTimeout(verticalDetectionTimer);
  }

  const requestId = ++verticalDetectionRequestId;
  const normalizedUrl = normalizeInputUrl(elements.feedUrl.value);

  if (!normalizedUrl || !isValidUrl(normalizedUrl)) {
    if (!elements.feedUrl.value.trim()) {
      elements.feedVertical.checked = false;
    }
    return;
  }

  verticalDetectionTimer = window.setTimeout(() => {
    void detectVerticalStateFromUrl(normalizedUrl, requestId);
  }, 280);
}

async function detectVerticalStateFromUrl(url, requestId) {
  const isVertical = await guessVerticalFromUrl(url);

  if (requestId !== verticalDetectionRequestId || isVertical === null) {
    return;
  }

  elements.feedVertical.checked = isVertical;
}

async function guessVerticalFromUrl(url) {
  const source = resolveFeedSource({ id: "preview", url, vertical: false });

  if (source.kind === "video") {
    return detectDirectVideoOrientation(url);
  }

  if (source.provider === "youtube") {
    return detectYouTubeOrientation(url);
  }

  return null;
}

async function detectDirectVideoOrientation(url) {
  return new Promise((resolve) => {
    const probe = document.createElement("video");
    let settled = false;

    const finish = (value) => {
      if (settled) {
        return;
      }

      settled = true;
      probe.removeAttribute("src");
      probe.load();
      resolve(value);
    };

    probe.preload = "metadata";
    probe.muted = true;
    probe.playsInline = true;
    probe.addEventListener("loadedmetadata", () => {
      finish(probe.videoHeight > probe.videoWidth);
    }, { once: true });
    probe.addEventListener("error", () => finish(null), { once: true });
    probe.src = url;
  });
}

async function detectYouTubeOrientation(url) {
  if (/\/shorts\//i.test(url)) {
    return true;
  }

  const videoId = extractYouTubeId(url);
  if (!videoId) {
    return null;
  }

  try {
    const response = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
      credentials: "omit"
    });
    const html = await response.text();
    const playerResponse = extractYouTubePlayerResponseFromHtml(html);
    const streamDimensions = getBestYouTubeStreamDimensions(playerResponse);

    if (streamDimensions) {
      return streamDimensions.height > streamDimensions.width;
    }

    const title = playerResponse?.videoDetails?.title || "";
    const description = playerResponse?.videoDetails?.shortDescription || "";
    return /\b(vertical|portrait)\b/i.test(`${title} ${description}`);
  } catch (error) {
    console.debug("Unable to auto-detect YouTube orientation", error);
    return null;
  }
}

async function handleFormSubmit(event) {
  event.preventDefault();

  let url = normalizeInputUrl(elements.feedUrl.value);
  if (isValidUrl(url)) {
    const source = resolveFeedSource({ id: "preview", url, vertical: false });
    if (source.provider === "generic") {
      url = await fetchEmbedUrlFallback(url);
    }
  }
  if (!isValidUrl(url)) {
    flashMessage("That link does not look complete yet. Paste the full address, including https://");
    elements.feedUrl.focus();
    return;
  }

  elements.feedUrl.value = url;
  resetFeedUrlFieldScroll();
  const existingIndex = state.feeds.findIndex((feed) => feed.id === state.editingId);
  const existingFeed = existingIndex >= 0 ? state.feeds[existingIndex] : null;
  const newTitle = await fetchVideoTitle(url, existingIndex >= 0 ? existingIndex : state.feeds.length);
  
  const record = {
    id: state.editingId || createFeedId(),
    title: existingFeed && existingFeed.url === url ? existingFeed.title : newTitle,
    vertical: elements.feedVertical.checked,
    url
  };
  const nextFeeds = existingIndex >= 0
    ? state.feeds.map((feed, index) => (index === existingIndex ? record : feed))
    : [...state.feeds, record];

  if (nextFeeds.length > MAX_FEEDS) {
    flashMessage("You already have 16 feeds saved. Delete one before adding another.");
    return;
  }

  const slotCapacity = getDynamicSlotCapacity(nextFeeds);
  if (nextFeeds.length > slotCapacity) {
    flashMessage(`That mix can fit ${slotCapacity} feed${slotCapacity === 1 ? "" : "s"} on this screen right now. Remove one or switch some feeds back to horizontal.`);
    return;
  }

  const sameUrl = Boolean(existingFeed) && urlsMatch(existingFeed.url, record.url);
  const shouldResetPlayback = Boolean(existingFeed) && !sameUrl;
  const isOrientationOnlyUpdate = Boolean(existingFeed) && sameUrl && existingFeed.vertical !== record.vertical;

  if (existingIndex >= 0) {
    state.feeds.splice(existingIndex, 1, record);
    flashMessage("Video updated");
  } else {
    if (record.vertical && window.DISABLE_AUTO_ARRANGE) {
      let insertIdx = 0;
      for (let i = 0; i < state.feeds.length; i++) {
         if (state.feeds[i].vertical) insertIdx = i + 1;
      }
      state.feeds.splice(insertIdx, 0, record);
    } else {
      state.feeds.push(record);
    }
    
    flashMessage("Video added");
  }

  if (shouldResetPlayback) {
    clearPlaybackPosition(record.id);
  }

  await persistFeeds();

  if (shouldResetPlayback) {
    await persistPlaybackPositions();
  }

  state.editingId = null;
  elements.feedForm.reset();
  renderForm();

  if (isOrientationOnlyUpdate) {
    renderFeedList();
    renderClearAllState();
    applyRenderedFeedOrientation(record.id, record.vertical);
    return;
  }

  render();
}

function syncFeedOrientation(feedId, isVertical) {
  const feedIndex = state.feeds.findIndex((feed) => feed.id === feedId);
  if (feedIndex < 0) {
    return;
  }

  const currentFeed = state.feeds[feedIndex];
  if (currentFeed.vertical === isVertical) {
    return;
  }

  const updatedFeed = {
    ...currentFeed,
    vertical: isVertical
  };

  state.feeds.splice(feedIndex, 1);

  if (isVertical && window.DISABLE_AUTO_ARRANGE) {
    let insertIdx = 0;
    for (let i = 0; i < state.feeds.length; i++) {
       if (state.feeds[i].vertical) insertIdx = i + 1;
    }
    state.feeds.splice(insertIdx, 0, updatedFeed);
  } else {
    state.feeds.push(updatedFeed);
  }

  applyRenderedFeedOrientation(feedId, isVertical);
  renderFeedList();
  void persistFeeds();
  syncGridTileOrder();
}

function applyRenderedFeedOrientation(feedId, isVertical) {
  const selector = `.feed-card[data-feed-id="${CSS.escape(feedId)}"]`;

  document.querySelectorAll(selector).forEach((tile) => {
    tile.dataset.orientation = isVertical ? "vertical" : "horizontal";

    if (!tile.classList.contains("feed-card-rail")) {
      tile.classList.toggle("feed-card-vertical", isVertical);
    }

    const orientationButton = tile.querySelector('[data-action="set-vertical"], [data-action="set-horizontal"]');
    if (orientationButton) {
      orientationButton.dataset.action = isVertical ? "set-horizontal" : "set-vertical";
      orientationButton.textContent = isVertical ? "Horizontal" : "Vertical";
    }

    if (window.DISABLE_AUTO_ARRANGE) {
      tile.dataset.autoSized = "true";
      tile.style.width = "";
      tile.style.height = "";
    }
  });

  if (state.focusId === feedId) {
    elements.feedGrid.dataset.focusOrientation = isVertical ? "vertical" : "horizontal";
  }

  if (!state.focusId) {
    syncGridTileOrder();
  }

  if (state.editingId === feedId) {
    elements.feedVertical.checked = isVertical;
  }

  scheduleLayoutRefresh();
  renderStatus();
  void resumeVisibleMedia({ feedId });
}

function syncGridTileOrder() {
  syncStandardGridLayout();
}

function handleGridClick(event) {
  const actionTarget = event.target.closest("[data-action]");
  if (actionTarget) {
    event.preventDefault();
    event.stopPropagation();
    const action = actionTarget.dataset.action;
    const feedId = actionTarget.dataset.feedId || "";

    if (action === "open-panel") {
      openPanel();
      return;
    }

    if (action === "remove") {
      const feed = state.feeds.find((item) => item.id === feedId);
      state.feeds = state.feeds.filter((item) => item.id !== feedId);

      if (state.editingId === feedId) {
        state.editingId = null;
      }

      if (state.focusId === feedId) {
        void closeFocus();
      }

      const removedPlayback = clearPlaybackPosition(feedId);
      void persistFeeds();

      if (removedPlayback) {
        void persistPlaybackPositions();
      }

      render();
      flashMessage(feed ? `Removed ${feed.title}.` : "Feed removed.");
      return;
    }

    if (action === "edit") {
      openPanel(feedId);
      return;
    }

    if (action === "set-vertical" || action === "set-horizontal") {
      syncFeedOrientation(feedId, action === "set-vertical");
      return;
    }

    if (action === "toggle-embed-play") {
      void toggleEmbeddedPlayback(feedId);
      return;
    }

    if (action === "toggle-embed-mute") {
      if (state.unmutedFeeds.has(feedId)) {
        state.unmutedFeeds.delete(feedId);
      } else {
        state.unmutedFeeds.add(feedId);
      }
      const tile = elements.feedGrid.querySelector(`.feed-card[data-feed-id="${CSS.escape(feedId)}"]`);
      const feed = state.feeds.find(f => f.id === feedId);
      if (tile && feed) {
        syncFeedCardMedia(tile, feed);
        renderFeedCustomControls(tile, feed);
      }
      return;
    }

    if (action === "focus") {
      void openFocus(feedId);
      return;
    }

    if (action === "clear-focus") {
      void closeFocus();
      return;
    }
  }
}

function handleWorkspaceClick(event) {
  if (!state.focusId || state.panelOpen) {
    return;
  }

  if (event.target.closest(".feed-card")) {
    return;
  }

  if (event.target.closest(".control-panel")) {
    return;
  }

  void closeFocus();
}

async function handleListClick(event) {
  const actionTarget = event.target.closest("[data-action]");
  if (!actionTarget) {
    return;
  }

  const action = actionTarget.dataset.action;
  const feedId = actionTarget.dataset.feedId;

  if (action === "edit") {
    openPanel(feedId);
    return;
  }

  if (action === "delete") {
    const feed = state.feeds.find((item) => item.id === feedId);
    state.feeds = state.feeds.filter((item) => item.id !== feedId);

    if (state.editingId === feedId) {
      state.editingId = null;
    }

    if (state.focusId === feedId) {
      await closeFocus();
    }

    const removedPlayback = clearPlaybackPosition(feedId);
    await persistFeeds();

    if (removedPlayback) {
      await persistPlaybackPositions();
    }

    render();
    flashMessage(feed ? `Deleted ${feed.title}.` : "Feed deleted.");
    return;
  }

  if (action === "move-up" || action === "move-down") {
    const currentIndex = state.feeds.findIndex((item) => item.id === feedId);
    const nextIndex = action === "move-up" ? currentIndex - 1 : currentIndex + 1;

    if (currentIndex < 0 || nextIndex < 0 || nextIndex >= state.feeds.length) {
      return;
    }

    const reordered = [...state.feeds];
    const [movedFeed] = reordered.splice(currentIndex, 1);
    reordered.splice(nextIndex, 0, movedFeed);
    state.feeds = reordered;
    await persistFeeds();
    render();
  }
}

function openPanel(feedId = null) {
  state.editingId = feedId || null;
  state.panelOpen = true;
  setTopChromeHidden(false);
  renderPanelState();
  renderForm();
  renderClearAllState();
  scheduleTopChromeMeasure();

  window.setTimeout(() => {
    elements.feedUrl.focus({ preventScroll: true });
    focusFeedUrlField();
  }, 40);
}

function closePanel() {
  state.panelOpen = false;
  cancelClearAll();
  renderPanelState();
}

function togglePanel() {
  if (state.panelOpen) {
    closePanel();
    return;
  }

  openPanel();
}

async function openFocus(feedId) {
  const feed = state.feeds.find((item) => item.id === feedId);
  if (!feed) {
    return;
  }

  if (state.panelOpen) {
    closePanel();
  }

  state.focusId = feedId;
  ignoreScrollJumps();
  setTopChromeHidden(true);
  render();
  await resumeVisibleMedia();
  scrollFocusedFeedIntoView();
  cleanupDetachedMedia();
}

async function closeFocus(options = {}) {
  state.focusId = null;
  ignoreScrollJumps();
  render();
  await resumeVisibleMedia();
  cleanupDetachedMedia();
}

function ignoreScrollJumps() {
  state.ignoreScrollJumpsUntil = Date.now() + 600;
}

function scrollFocusedFeedIntoView() {
  ignoreScrollJumps();
  const top = elements.feedGrid.getBoundingClientRect().top + window.scrollY - getShellPadding();
  window.scrollTo({
    top: Math.max(0, top),
    behavior: "auto"
  });
}

async function resetForm() {
  if (!state.editingId) {
    state.editingId = null;
    elements.feedForm.reset();
    renderForm();
    return;
  }

  const feedId = state.editingId;
  const feed = state.feeds.find((item) => item.id === feedId);

  state.feeds = state.feeds.filter((item) => item.id !== feedId);
  state.editingId = null;

  if (state.focusId === feedId) {
    await closeFocus();
  }

  const removedPlayback = clearPlaybackPosition(feedId);
  await persistFeeds();

  if (removedPlayback) {
    await persistPlaybackPositions();
  }

  elements.feedForm.reset();
  render();
  flashMessage(feed ? `Removed ${feed.title}.` : "Video removed.");
}

async function snapshotVisibleVideoPlayback() {
  const videos = document.querySelectorAll(".feed-card video");

  videos.forEach((video) => {
    const feedId = video.closest(".feed-card")?.dataset.feedId;
    if (!feedId || !Number.isFinite(video.currentTime)) {
      return;
    }

    state.playbackPositions = {
      ...state.playbackPositions,
      [feedId]: Math.floor(video.currentTime)
    };
  });

  if (videos.length) {
    await persistPlaybackPositions();
  }
}

async function handleClearAllClick() {
  if (!state.feeds.length) {
    return;
  }

  if (!state.confirmingClearAll) {
    state.confirmingClearAll = true;
    renderClearAllState();
    return;
  }

  state.feeds = [];
  state.editingId = null;
  cancelClearAll({ silent: true });
  await closeFocus({ skipSnapshot: true });
  state.playbackPositions = {};

  await Promise.all([
    clearFeedStorage(),
    clearPlaybackStorage()
  ]);

  render();
  flashMessage(isIncognitoContext() ? "Private-window feeds cleared." : "All saved feeds cleared.");
}

function cancelClearAll(options = {}) {
  state.confirmingClearAll = false;

  if (!options.silent) {
    renderClearAllState();
  }
}

async function handleClearOnCloseToggleChange(event) {
  state.clearOnClose = event.target.checked;
  await persistSettings();
  renderClearOnCloseState();
  await syncClearOnCloseWithBackground();

  const message = state.clearOnClose
    ? "Close warning turned on for this monitor tab."
    : "Close warning turned off.";

  flashMessage(message);
}

async function handleRestartAllClick() {
  if (!state.feeds.length) {
    flashMessage("Add at least one feed before restarting everything.");
    return;
  }

  clearPendingPlaybackSaves();
  state.playbackPositions = {};
  await persistPlaybackPositions();
  await restartVisibleMedia();

  flashMessage("All feeds restarted from the beginning or pushed back to live.");
}

function handlePauseAllClick() {
  if (!state.feeds.length) {
    flashMessage("Add at least one feed before pausing everything.");
    return;
  }

  pauseVisibleMedia();
  flashMessage("All visible feeds paused.");
}

async function restartVisibleMedia() {
  const restartToken = Date.now();
  const playPromises = [];
  const iframeTasks = [];

  document.querySelectorAll(".feed-card video").forEach((video) => {
    try {
      video.currentTime = 0;
    } catch (error) {
      console.debug("Unable to restart direct video", error);
    }

    const maybePromise = video.play();
    if (maybePromise?.catch) {
      playPromises.push(maybePromise.catch(() => {}));
    }
  });

  for (const frame of youtubeFrames.values()) {
    sendYouTubeCommand(frame, "seekTo", [0, true]);
    sendYouTubeCommand(frame, "playVideo", []);
  }

  document.querySelectorAll(".feed-card iframe").forEach((iframe) => {
    const feedId = iframe.closest(".feed-card")?.dataset.feedId;
    const feed = feedId ? state.feeds.find((item) => item.id === feedId) : null;

    if (!feed) {
      return;
    }

    const source = resolveFeedSource(feed);

    if (source.provider === "youtube") {
      return;
    }

    iframeTasks.push((async () => {
      const restarted = await sendEmbeddedMediaCommand(iframe, "restart", {
        customUi: shouldActivateCustomEmbedUi(feed),
        timeoutMs: 700
      });
      if (restarted?.success) {
        return;
      }

      await syncIframeElementSource(iframe, source, feed, getEffectiveMuted(feed.id), {
        forceReload: true,
        token: restartToken
      });
      await waitForIframeLoad(iframe);
      await sendEmbeddedMediaCommand(iframe, "play", {
        customUi: shouldActivateCustomEmbedUi(feed),
        timeoutMs: 900
      });
    })());
  });

  if (playPromises.length) {
    void Promise.allSettled(playPromises);
  }

  if (iframeTasks.length) {
    await Promise.allSettled(iframeTasks);
  }
}

function pauseVisibleMedia() {
  document.querySelectorAll(".feed-card video").forEach((video) => {
    video.pause();
  });

  for (const frame of youtubeFrames.values()) {
    sendYouTubeCommand(frame, "pauseVideo", []);
  }

  document.querySelectorAll(".feed-card iframe").forEach((iframe) => {
    const feedId = iframe.closest(".feed-card")?.dataset.feedId || "";
    const feed = state.feeds.find((item) => item.id === feedId);

    if (iframe.src.includes("youtube-nocookie.com/embed/") || iframe.src.includes("youtube.com/embed/")) {
      return;
    }

    void sendEmbeddedMediaCommand(iframe, "pause", {
      customUi: Boolean(feed && shouldActivateCustomEmbedUi(feed))
    });
  });
}

async function persistFeeds() {
  await writeFeeds(state.feeds);
}

async function persistSettings() {
  await writeSettings({ clearOnClose: state.clearOnClose });
}

async function persistPlaybackPositions() {
  await writePlaybackPositions(state.playbackPositions);
}

async function readFeeds() {
  return normalizeFeedArray(await readStoredValue(FEEDS_KEY));
}

async function writeFeeds(feeds) {
  await writeStoredValue(FEEDS_KEY, feeds);
}

async function clearFeedStorage() {
  await removeStoredValue(FEEDS_KEY);
}

async function readSettings() {
  return normalizeSettings(await readStoredValue(SETTINGS_KEY));
}

async function writeSettings(settings) {
  await writeStoredValue(SETTINGS_KEY, settings);
}

async function readPlaybackPositions() {
  return normalizePlaybackPositions(await readStoredValue(PLAYBACK_KEY));
}

async function writePlaybackPositions(positions) {
  await writeStoredValue(PLAYBACK_KEY, positions);
}

async function clearPlaybackStorage() {
  await removeStoredValue(PLAYBACK_KEY);
}

function clearPlaybackPosition(feedId) {
  if (!(feedId in state.playbackPositions)) {
    return false;
  }

  const nextPositions = { ...state.playbackPositions };
  delete nextPositions[feedId];
  state.playbackPositions = nextPositions;
  return true;
}

function queuePlaybackPositionSave(feedId, seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) {
    return;
  }

  const roundedSeconds = Math.floor(seconds);
  if (state.playbackPositions[feedId] === roundedSeconds) {
    return;
  }

  state.playbackPositions = {
    ...state.playbackPositions,
    [feedId]: roundedSeconds
  };

  if (playbackSaveTimers.has(feedId)) {
    window.clearTimeout(playbackSaveTimers.get(feedId));
  }

  const timer = window.setTimeout(() => {
    playbackSaveTimers.delete(feedId);
    void persistPlaybackPositions();
  }, PLAYBACK_SAVE_DEBOUNCE_MS);

  playbackSaveTimers.set(feedId, timer);
}

function clearPendingPlaybackSaves() {
  for (const timer of playbackSaveTimers.values()) {
    window.clearTimeout(timer);
  }

  playbackSaveTimers.clear();
}

function getSavedPlaybackPosition(feedId) {
  const saved = state.playbackPositions[feedId];
  return Number.isFinite(saved) && saved > 0 ? saved : 0;
}

function clampPlaybackTime(seconds, duration) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }

  if (!Number.isFinite(duration) || duration <= 0) {
    return seconds;
  }

  return Math.min(seconds, Math.max(duration - 1, 0));
}

async function syncClearOnCloseWithBackground() {
  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) {
    return;
  }

  try {
    await chrome.runtime.sendMessage({
      type: "monitor:set-clear-on-close",
      enabled: state.clearOnClose
    });
  } catch (error) {
    console.debug("Unable to sync clear-on-close state", error);
  }
}

function handleBeforeUnload(event) {
  if (!state.clearOnClose || !state.feeds.length) {
    return;
  }

  event.preventDefault();
  event.returnValue = "";
}

function handleEmbeddedPlayerMessage(event) {
  const payload = parseEmbeddedMessage(event.data);
  if (!payload) {
    return;
  }


  if (payload.type === "situation-monitor-native-unmute" || payload.type === "situation-monitor-native-mute") {
    const frames = Array.from(document.querySelectorAll("iframe"));
    const match = frames.find(f => f.contentWindow === event.source);
    if (match && match.dataset.feedId) {
      if (payload.type === "situation-monitor-native-unmute") {
        state.unmutedFeeds.add(match.dataset.feedId);
        match.closest(".feed-card").dataset.lastMutedState = "false";
      } else {
        state.unmutedFeeds.delete(match.dataset.feedId);
        match.closest(".feed-card").dataset.lastMutedState = "true";
      }
    }
    return;
  }

  if (payload.type === EMBED_WHEEL_MESSAGE_TYPE) {

    if (EMBED_WHEEL_MESSAGE_ORIGINS.has(event.origin) && !state.panelOpen) {
      handleTopChromeWheelDelta(Number(payload.deltaY));
    }
    return;
  }

  if (payload.type === EMBED_CONTROL_RESULT_MESSAGE_TYPE) {
    if (EMBED_WHEEL_MESSAGE_ORIGINS.has(event.origin) && typeof payload.requestId === "string") {
      resolvePendingEmbedCommand(payload.requestId, payload);
    }
    return;
  }

  if (!YOUTUBE_MESSAGE_ORIGINS.has(event.origin)) {
    return;
  }

  const frame = findYouTubeFrameBySource(event.source);
  if (!frame) {
    return;
  }

  if (payload.event === "onReady") {
    maybeRestoreYouTubePosition(frame);
  }

  const playerState = getYouTubePlayerState(payload);
  if (playerState !== null) {
    handleYouTubePlayerState(frame.feedId, playerState);
  }

  if (payload.info && typeof payload.info.currentTime === "number") {
    queuePlaybackPositionSave(frame.feedId, payload.info.currentTime);
    maybeRestoreYouTubePosition(frame);
  }
}

function parseEmbeddedMessage(value) {
  if (!value) {
    return null;
  }

  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch (error) {
      return null;
    }
  }

  return typeof value === "object" ? value : null;
}

function findYouTubeFrameBySource(source) {
  for (const frame of youtubeFrames.values()) {
    if (frame.iframe.contentWindow === source) {
      return frame;
    }
  }

  return null;
}

function findYouTubeFrameByFeedId(feedId) {
  for (const frame of youtubeFrames.values()) {
    if (frame.feedId === feedId) {
      return frame;
    }
  }

  return null;
}

function getYouTubePlayerState(payload) {
  if (payload?.event === "onStateChange" && Number.isFinite(payload.info)) {
    return Number(payload.info);
  }

  if (payload?.info && Number.isFinite(payload.info.playerState)) {
    return Number(payload.info.playerState);
  }

  return null;
}

function handleYouTubePlayerState(feedId, playerState) {
  const entry = getPlaybackHealthEntry(feedId, "youtube");

  if (playerState === 3) {
    openPlaybackBuffer(feedId, "youtube");
    renderStatus();
    return;
  }

  if (playerState === 1) {
    if (!entry.hasStartedPlaying && entry.startupStartedAt) {
      entry.startupDelayMs = Math.max(0, performance.now() - entry.startupStartedAt);
      entry.hasStartedPlaying = true;
    }

    closePlaybackBuffer(feedId);
    renderStatus();
    return;
  }

  if ([0, 2, 5].includes(playerState)) {
    closePlaybackBuffer(feedId);
    renderStatus();
  }
}

function handleViewportChange() {
  syncTopChromeMetrics();
  cleanupDetachedMedia();
}

function handleWindowScroll() {
  if (state.panelOpen) {
    return;
  }

  const currentY = window.scrollY;
  const delta = currentY - lastScrollY;

  // Ignore negative scroll delta if we just changed the topbar layout
  if (state.ignoreScrollJumpsUntil && Date.now() < state.ignoreScrollJumpsUntil) {
    lastScrollY = currentY;
    return;
  }

  if (currentY <= TOPBAR_HIDE_SCROLL_START && delta < 0) {
    setTopChromeHidden(false);
    lastScrollY = currentY;
    return;
  }

  if (delta >= TOPBAR_HIDE_SCROLL_DELTA) {
    topChromeRevealBlockedUntil = performance.now() + 280;
    setTopChromeHidden(true);
  } else if (delta <= -TOPBAR_HIDE_SCROLL_DELTA) {
    setTopChromeHidden(false);
  }

  lastScrollY = currentY;
}

function handleWindowWheel(event) {
  if (state.panelOpen) {
    return;
  }

  handleTopChromeWheelDelta(event.deltaY);
}

function handleWindowMouseMove(event) {
  if (state.panelOpen || !state.topChromeHidden) {
    return;
  }

  if (performance.now() < topChromeRevealBlockedUntil) {
    return;
  }

  if (event.clientY <= TOPBAR_EDGE_REVEAL) {
    setTopChromeHidden(false);
  }
}

function setTopChromeHidden(hidden) {
  if (state.topChromeHidden === hidden || (hidden && state.feeds.length === 0)) {
    return;
  }

  state.topChromeHidden = hidden;
  ignoreScrollJumps();
  renderTopChromeState();
  
  if (layoutTimer) {
    window.clearTimeout(layoutTimer);
  }
  
  layoutTimer = window.setTimeout(() => {
    applyLayoutMetrics();
  }, 220);
}

function normalizeFeedArray(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((feed) => feed && typeof feed === "object")
    .slice(0, MAX_FEEDS)
    .map((feed, index) => ({
      id: typeof feed.id === "string" && feed.id ? feed.id : createFeedId(),
      title: typeof feed.title === "string" && feed.title.trim() ? feed.title.trim() : deriveFeedTitle(feed.url, index),
      vertical: Boolean(feed.vertical),
      url: typeof feed.url === "string" ? feed.url.trim() : ""
    }))
    .filter((feed) => Boolean(feed.url));
}

function normalizeSettings(value) {
  return {
    clearOnClose: Boolean(value && typeof value === "object" && value.clearOnClose)
  };
}

function normalizePlaybackPositions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return Object.fromEntries(
    Object.entries(value)
      .filter((entry) => typeof entry[0] === "string")
      .map(([feedId, seconds]) => [feedId, Number(seconds)])
      .filter((entry) => Number.isFinite(entry[1]) && entry[1] >= 0)
      .map(([feedId, seconds]) => [feedId, Math.floor(seconds)])
  );
}

async function readStoredValue(key) {
  const storageArea = getScopedStorageArea();
  const storageKey = getScopedStorageKey(key);

  if (storageArea) {
    const stored = await new Promise((resolve) => {
      storageArea.get(storageKey, resolve);
    });

    const value = stored[storageKey];
    return shouldEncryptScopedValue() ? decryptScopedValue(value) : value;
  }

  try {
    const raw = getBrowserStorage().getItem(storageKey);
    const value = raw ? JSON.parse(raw) : null;
    return shouldEncryptScopedValue() ? decryptScopedValue(value) : value;
  } catch (error) {
    console.error("Unable to read stored value", error);
    return null;
  }
}

async function migrateLegacyIncognitoSessionStorage() {
  if (!isIncognitoContext() || !chrome.storage?.session || !chrome.storage?.local) {
    return;
  }

  const scopedKeys = [
    getScopedStorageKey(FEEDS_KEY),
    getScopedStorageKey(SETTINGS_KEY),
    getScopedStorageKey(PLAYBACK_KEY)
  ];

  const existingLocalValues = await new Promise((resolve) => {
    chrome.storage.local.get(scopedKeys, resolve);
  });

  const hasEncryptedCopy = scopedKeys.some((key) => key in existingLocalValues);
  if (hasEncryptedCopy) {
    return;
  }

  const legacyValues = await new Promise((resolve) => {
    chrome.storage.session.get([FEEDS_KEY, SETTINGS_KEY, PLAYBACK_KEY], resolve);
  });

  const hasLegacyValues = [FEEDS_KEY, SETTINGS_KEY, PLAYBACK_KEY].some((key) => key in legacyValues);
  if (!hasLegacyValues) {
    return;
  }

  if (FEEDS_KEY in legacyValues) {
    await writeStoredValue(FEEDS_KEY, legacyValues[FEEDS_KEY]);
  }

  if (SETTINGS_KEY in legacyValues) {
    await writeStoredValue(SETTINGS_KEY, legacyValues[SETTINGS_KEY]);
  }

  if (PLAYBACK_KEY in legacyValues) {
    await writeStoredValue(PLAYBACK_KEY, legacyValues[PLAYBACK_KEY]);
  }

  await new Promise((resolve) => {
    chrome.storage.session.remove([FEEDS_KEY, SETTINGS_KEY, PLAYBACK_KEY], resolve);
  });
}

async function writeStoredValue(key, value) {
  const storageArea = getScopedStorageArea();
  const storageKey = getScopedStorageKey(key);
  const nextValue = shouldEncryptScopedValue() ? await encryptScopedValue(value) : value;

  if (storageArea) {
    await new Promise((resolve) => {
      storageArea.set({ [storageKey]: nextValue }, resolve);
    });
    return;
  }

  getBrowserStorage().setItem(storageKey, JSON.stringify(nextValue));
}

async function removeStoredValue(key) {
  const storageArea = getScopedStorageArea();
  const storageKey = getScopedStorageKey(key);

  if (storageArea) {
    await new Promise((resolve) => {
      storageArea.remove(storageKey, resolve);
    });
    return;
  }

  getBrowserStorage().removeItem(storageKey);
}

function extractYouTubeId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "");

    if (host === "youtu.be") {
      return url.pathname.split("/").filter(Boolean)[0] || null;
    }

    if (host === "youtube.com" || host === "m.youtube.com" || host === "youtube-nocookie.com") {
      if (url.pathname === "/watch") {
        return url.searchParams.get("v");
      }

      const segments = url.pathname.split("/").filter(Boolean);
      if (["embed", "live", "shorts"].includes(segments[0])) {
        return segments[1] || null;
      }
    }
  } catch (error) {
    return null;
  }

  return null;
}

function extractVimeoId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "");

    if (host !== "vimeo.com" && host !== "player.vimeo.com") {
      return null;
    }

    const segments = url.pathname.split("/").filter(Boolean);
    const candidate = segments.reverse().find((segment) => /^\d+$/.test(segment));
    return candidate || null;
  } catch (error) {
    return null;
  }
}

function extractDailymotionId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "");
    const segments = url.pathname.split("/").filter(Boolean);

    if (host === "dai.ly") {
      return segments[0] || null;
    }

    if (host === "dailymotion.com" || host.endsWith(".dailymotion.com")) {
      if (segments[0] === "video" || (segments[0] === "embed" && segments[1] === "video")) {
        return segments[segments[0] === "video" ? 1 : 2] || null;
      }
    }
  } catch (error) {
    return null;
  }

  return null;
}

function extractLoomId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "");
    const segments = url.pathname.split("/").filter(Boolean);

    if (host !== "loom.com" && !host.endsWith(".loom.com")) {
      return null;
    }

    if (segments[0] === "share" || segments[0] === "embed") {
      return segments[1] || null;
    }
  } catch (error) {
    return null;
  }

  return null;
}

function extractStreamableId(rawUrl) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "");
    const segments = url.pathname.split("/").filter(Boolean);

    if ((host !== "streamable.com" && !host.endsWith(".streamable.com")) || !segments.length) {
      return null;
    }

    if (segments[0] === "e") {
      return segments[1] || null;
    }

    return segments[0];
  } catch (error) {
    return null;
  }
}


function extractBalancedJson(text, startIndex) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = startIndex; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(startIndex, index + 1);
      }
    }
  }

  return "";
}

function getBestYouTubeStreamDimensions(playerResponse) {
  const streamingData = playerResponse?.streamingData;
  const formats = [
    ...(Array.isArray(streamingData?.formats) ? streamingData.formats : []),
    ...(Array.isArray(streamingData?.adaptiveFormats) ? streamingData.adaptiveFormats : [])
  ];
  const withDimensions = formats
    .filter((format) => Number.isFinite(format?.width) && Number.isFinite(format?.height))
    .sort((left, right) => (right.width * right.height) - (left.width * left.height));

  if (!withDimensions.length) {
    return null;
  }

  return {
    height: withDimensions[0].height,
    width: withDimensions[0].width
  };
}

function isValidUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (error) {
    return false;
  }
}


async function fetchEmbedUrlFallback(url) {
  try {
    const res = await fetch(url);
    const html = await res.text();
    let match = html.match(/<meta[^>]+property=["']og:video(:url)?["'][^>]+content=["']([^"']+)["']/i);
    if (!match) match = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:video(:url)?["']/i);
    if (!match) match = html.match(/<meta[^>]+name=["']twitter:player["'][^>]+content=["']([^"']+)["']/i);
    if (!match) match = html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:player["']/i);
    
    if (match && match[2]) {
      const decoded = match[2].replace(/&amp;/g, '&').replace(/&quot;/g, '"');
      try { return new URL(decoded, url).href; } catch(e) { return decoded; }
    }
    
    const iframeMatches = [...html.matchAll(/<iframe[^>]+src=["']([^"']+)["']/gi)];
    for (const iframeMatch of iframeMatches) {
      if (iframeMatch[1] && (iframeMatch[1].includes('embed') || iframeMatch[1].includes('player') || iframeMatch[1].includes('video'))) {
        const decoded = iframeMatch[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"');
        try { return new URL(decoded, url).href; } catch(e) { return decoded; }
      }
    }
  } catch (err) {
    console.debug('Fallback fetch failed:', err);
  }
  return url;
}

function normalizeInputUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  if (/^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed)) {
    return trimmed;
  }

  if (/^(www\.|[\w-]+\.[a-z]{2,})/i.test(trimmed)) {
    return `https://${trimmed}`;
  }

  return trimmed;
}

function urlsMatch(left, right) {
  try {
    const leftUrl = new URL(normalizeInputUrl(left));
    const rightUrl = new URL(normalizeInputUrl(right));
    const normalizeUrl = (url) => {
      url.hash = "";

      if ((url.protocol === "https:" && url.port === "443") || (url.protocol === "http:" && url.port === "80")) {
        url.port = "";
      }

      if (url.pathname.length > 1) {
        url.pathname = url.pathname.replace(/\/+$/, "");
      }

      return url.toString();
    };

    return normalizeUrl(leftUrl) === normalizeUrl(rightUrl);
  } catch (error) {
    return normalizeInputUrl(left) === normalizeInputUrl(right);
  }
}

function flashMessage(message) {
  elements.messageBar.hidden = false;
  elements.messageBar.textContent = message;
  scheduleTopChromeMeasure();

  if (messageTimer) {
    window.clearTimeout(messageTimer);
  }

  messageTimer = window.setTimeout(() => {
    elements.messageBar.hidden = true;
    scheduleTopChromeMeasure();
  }, 2600);
}

function hasChromeStorage() {
  return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
}

function shouldEncryptScopedValue() {
  return isIncognitoContext();
}

function getScopedStorageKey(key) {
  return isIncognitoContext() ? `${key}${INCOGNITO_STORAGE_SUFFIX}` : key;
}

function bytesToBase64(bytes) {
  let binary = "";

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary);
}

function base64ToBytes(value) {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

async function getIncognitoCryptoKey() {
  if (incognitoCryptoKeyPromise) {
    return incognitoCryptoKeyPromise;
  }

  incognitoCryptoKeyPromise = (async () => {
    if (!hasChromeStorage() || !window.crypto?.subtle) {
      return null;
    }

    const stored = await new Promise((resolve) => {
      chrome.storage.local.get(INCOGNITO_ENCRYPTION_KEY_KEY, resolve);
    });

    let rawKey = stored[INCOGNITO_ENCRYPTION_KEY_KEY];

    if (typeof rawKey !== "string" || !rawKey) {
      const generated = new Uint8Array(32);
      window.crypto.getRandomValues(generated);
      rawKey = bytesToBase64(generated);

      await new Promise((resolve) => {
        chrome.storage.local.set({ [INCOGNITO_ENCRYPTION_KEY_KEY]: rawKey }, resolve);
      });
    }

    return window.crypto.subtle.importKey(
      "raw",
      base64ToBytes(rawKey),
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"]
    );
  })();

  return incognitoCryptoKeyPromise;
}

async function encryptScopedValue(value) {
  if (!shouldEncryptScopedValue()) {
    return value;
  }

  const cryptoKey = await getIncognitoCryptoKey();
  if (!cryptoKey || !window.crypto?.subtle) {
    return value;
  }

  const encoded = new TextEncoder().encode(JSON.stringify(value));
  const iv = new Uint8Array(12);
  window.crypto.getRandomValues(iv);
  const cipherBuffer = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, encoded);

  return {
    cipher: bytesToBase64(new Uint8Array(cipherBuffer)),
    iv: bytesToBase64(iv),
    version: 1
  };
}

async function decryptScopedValue(value) {
  if (!shouldEncryptScopedValue()) {
    return value;
  }

  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.cipher !== "string" || typeof value.iv !== "string") {
    return value;
  }

  const cryptoKey = await getIncognitoCryptoKey();
  if (!cryptoKey || !window.crypto?.subtle) {
    return null;
  }

  try {
    const plaintext = await window.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64ToBytes(value.iv) },
      cryptoKey,
      base64ToBytes(value.cipher)
    );

    return JSON.parse(new TextDecoder().decode(plaintext));
  } catch (error) {
    console.error("Unable to decrypt stored value", error);
    return null;
  }
}

async function hardenStorageAccess() {
  if (!hasChromeStorage()) {
    return;
  }

  const tasks = [];

  if (chrome.storage.local?.setAccessLevel) {
    tasks.push(chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }));
  }

  if (chrome.storage.session?.setAccessLevel) {
    tasks.push(chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }));
  }

  if (!tasks.length) {
    return;
  }

  try {
    await Promise.all(tasks);
  } catch (error) {
    console.debug("Unable to harden storage access", error);
  }
}

function getScopedStorageArea() {
  if (!hasChromeStorage()) {
    return null;
  }

  return chrome.storage.local;
}

function isIncognitoContext() {
  return Boolean(
    typeof chrome !== "undefined" &&
    chrome.extension &&
    chrome.extension.inIncognitoContext
  );
}

function getBrowserStorage() {
  return isIncognitoContext() ? window.sessionStorage : window.localStorage;
}

function getBrowserStorageKey(key) {
  return getScopedStorageKey(key);
}

function createFeedId() {
  return `feed_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function handleTopChromeWheelDelta(deltaY) {
  if (!Number.isFinite(deltaY)) {
    return;
  }

  if (deltaY <= -TOPBAR_HIDE_WHEEL_DELTA) {
    setTopChromeHidden(false);
    return;
  }

  if (deltaY >= TOPBAR_HIDE_WHEEL_DELTA) {
    topChromeRevealBlockedUntil = performance.now() + 280;
    setTopChromeHidden(true);
  }
}

async function fetchVideoTitle(url, index) {
  const source = resolveFeedSource({ id: "preview", url, vertical: false });
  if (source.provider === "youtube") {
    try {
      const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
      const data = await res.json();
      if (data && data.title) {
        return data.title;
      }
    } catch (e) {}
  }
  if (source.provider === "vimeo") {
    try {
      const res = await fetch(`https://vimeo.com/api/oembed.json?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      if (data && data.title) {
        return data.title;
      }
    } catch (e) {}
  }
  return deriveFeedTitle(url, index);
}

function deriveFeedTitle(rawUrl, index = 0) {
  try {
    const url = new URL(rawUrl);
    const host = url.hostname.replace(/^www\./, "");
    const base = host.split(".")[0];

    if (base) {
      return toTitleCase(base.replace(/[-_]+/g, " ")).slice(0, 40);
    }
  } catch (error) {
    console.debug("Unable to derive a feed title from the link", error);
  }

  return `Feed ${index + 1}`;
}

function simplifyFeedUrl(rawUrl) {
  try {
    return new URL(rawUrl).href.replace(/^https?:\/\//, "");
  } catch (error) {
    return rawUrl;
  }
}

function toTitleCase(value) {
  return value.replace(/\b\w/g, (character) => character.toUpperCase());
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
