const monitorUrl = chrome.runtime.getURL("monitor.html");
const FEEDS_KEY = "situation-monitor-feeds";
const PLAYBACK_KEY = "situation-monitor-playback";
const INCOGNITO_STORAGE_SUFFIX = "-incognito";
const CLEAR_ON_CLOSE_TABS_KEY = "situation-monitor-clear-on-close-tabs";
const YOUTUBE_FRAME_HOSTS = [
  "www.youtube.com",
  "www.youtube-nocookie.com"
];
const YOUTUBE_REFERER_RULE_ID = 153;

async function hardenStorageAccess() {
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

async function ensureYouTubeRefererRule() {
  const rule = {
    id: YOUTUBE_REFERER_RULE_ID,
    condition: {
      initiatorDomains: [chrome.runtime.id],
      requestDomains: YOUTUBE_FRAME_HOSTS,
      resourceTypes: ["sub_frame"]
    },
    action: {
      type: "modifyHeaders",
      requestHeaders: [
        {
          header: "referer",
          operation: "set",
          value: `chrome-extension://${chrome.runtime.id}/`
        }
      ]
    }
  };

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [YOUTUBE_REFERER_RULE_ID],
    addRules: [rule]
  });
}

async function readClearOnCloseTabs() {
  const stored = await chrome.storage.session.get(CLEAR_ON_CLOSE_TABS_KEY);
  const value = stored[CLEAR_ON_CLOSE_TABS_KEY];
  return value && typeof value === "object" ? value : {};
}

async function writeClearOnCloseTabs(value) {
  await chrome.storage.session.set({ [CLEAR_ON_CLOSE_TABS_KEY]: value });
}

async function syncClearOnCloseTab(tabId, enabled, incognito) {
  if (!Number.isInteger(tabId)) {
    return;
  }

  const watchedTabs = await readClearOnCloseTabs();
  const key = String(tabId);

  if (enabled) {
    watchedTabs[key] = { incognito: Boolean(incognito) };
  } else {
    delete watchedTabs[key];
  }

  await writeClearOnCloseTabs(watchedTabs);
}

function getScopedStorageKey(key, incognito) {
  return incognito ? `${key}${INCOGNITO_STORAGE_SUFFIX}` : key;
}

async function clearMonitorMemory(entry) {
  await chrome.storage.local.remove([
    getScopedStorageKey(FEEDS_KEY, entry.incognito),
    getScopedStorageKey(PLAYBACK_KEY, entry.incognito)
  ]);
}

async function handleMonitorTabClosed(tabId) {
  const watchedTabs = await readClearOnCloseTabs();
  const key = String(tabId);
  const entry = watchedTabs[key];

  if (!entry) {
    return;
  }

  delete watchedTabs[key];
  await writeClearOnCloseTabs(watchedTabs);
  await clearMonitorMemory(entry);
}

chrome.runtime.onInstalled.addListener(() => {
  void hardenStorageAccess();
  void ensureYouTubeRefererRule();
});

chrome.runtime.onStartup.addListener(() => {
  void hardenStorageAccess();
  void ensureYouTubeRefererRule();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "monitor:set-clear-on-close") {
    return false;
  }

  const tabId = sender.tab?.id;
  const incognito = sender.tab?.incognito;

  void syncClearOnCloseTab(tabId, Boolean(message.enabled), incognito)
    .then(() => sendResponse({ ok: true }))
    .catch((error) => {
      console.error("Unable to update clear-on-close state", error);
      sendResponse({ ok: false });
    });

  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void handleMonitorTabClosed(tabId);
});

void hardenStorageAccess();
void ensureYouTubeRefererRule();

chrome.action.onClicked.addListener(async (tab) => {
  try {
    const existingTabs = await chrome.tabs.query({ url: monitorUrl });
    const existingTab = existingTabs.find((candidate) => candidate.incognito === Boolean(tab?.incognito));

    if (existingTab?.id) {
      await chrome.tabs.update(existingTab.id, { active: true });

      if (existingTab.windowId) {
        await chrome.windows.update(existingTab.windowId, { focused: true });
      }

      return;
    }

    const createOptions = { url: monitorUrl };
    if (tab?.windowId) {
      createOptions.windowId = tab.windowId;
    }

    await chrome.tabs.create(createOptions);
  } catch (error) {
    console.error("Unable to open Situation Monitor", error);
  }
});
