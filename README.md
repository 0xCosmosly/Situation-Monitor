# Situation Monitor 📺

Ever needed to keep an eye on multiple streams, live feeds, or videos at once? Situation Monitor is a lightweight Chrome extension that turns a single tab into your personal command center.

Add up to 16 video feeds, and watch as they neatly auto-arrange themselves into the perfect grid. It's built entirely on web standards, keeping things snappy and completely private.

## Features that make it great

- **Smart Auto-Grid**: Just paste a link and the extension instantly calculates the best layout to maximize your screen real estate.
- **Mix & Match Orientations**: Fully supports both horizontal (16:9) and vertical (9:16) videos like YouTube Shorts or TikToks. It even detects the aspect ratio automatically for you.
- **Drag & Drop**: Grab any feed by the handle in the corner and drop it exactly where you want it in the grid.
- **Picture-in-Picture Focus**: Click on any tile to bring it to the center stage for a closer look while keeping the rest of your feeds visible on the side.
- **Seamless Integrations**: Natively embeds YouTube, Vimeo, Dailymotion, Loom, Streamable, and any direct `.mp4`/`.webm` video links with custom, synchronized playback controls.
- **Built-in Adblocker**: Includes a massive declarative adblocking ruleset to ensure your streams are completely free of popups and trackers.
- **True Privacy**: Your feeds are stored locally in your browser. Using an Incognito window? The extension encrypts your session and stores it entirely in memory, wiping everything clean the second you close the tab.

## Getting Started

Because this extension isn't on the Chrome Web Store yet, you'll need to load it manually (it takes 30 seconds!):

1. Download or clone this repository to your computer.
2. Open Chrome and go to `chrome://extensions` in your URL bar.
3. Turn on **Developer mode** in the top right corner.
4. Click **Load unpacked** and select the folder you just downloaded.
5. Click the new Situation Monitor icon in your toolbar to open your dashboard!

### Using in Incognito Mode
Want to monitor feeds without leaving a trace? 
1. Head back to `chrome://extensions` and find Situation Monitor.
2. Click **Details**.
3. Toggle on **Allow in Incognito**.
4. Open an Incognito window and click the extension icon. Your feeds here will be totally isolated from your normal browsing session!

## Under the Hood
This extension is powered by vanilla JavaScript, CSS, and HTML. No heavy frameworks, no external tracking, and no bloat.

- `manifest.json` handles the extension permissions (like storage and the adblocking rules).
- `monitor.js` is the brains of the operation—handling the drag-and-drop math, grid calculations, and video embedding.
- `embedded-wheel-bridge.js` is a content script injected into the video iframes to let you scroll and control volume across cross-origin boundaries seamlessly!

---
*I'm monitoring the Chrome extension situation...*