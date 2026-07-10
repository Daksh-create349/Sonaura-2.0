// background.js - Sonaura 2.0 Orchestrator

let activeTabId = null;

// Listen to messages from popup or offscreen
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'init-capture') {
    const { streamId, tabId } = message;
    
    const startNewCapture = () => {
      activeTabId = tabId;
      // Retrieve settings in the service worker where chrome.storage is fully accessible
      chrome.storage.local.get(['sonauraSettings'], (res) => {
        const settings = res.sonauraSettings || null;
        setupOffscreenDocument(streamId, tabId, settings)
          .then(() => sendResponse({ success: true }))
          .catch((err) => sendResponse({ success: false, error: err.message }));
      });
    };

    // Query actual browser state to see if any tab has an active capture
    chrome.tabCapture.getCapturedTabs((capturedTabs) => {
      const activeTabs = (capturedTabs || []).filter(
        (t) => t.status === 'active' || t.status === 'pending'
      );
      
      if (activeTabs.length > 0) {
        // Stop all existing capture processes first
        stopCapture().then(() => {
          setTimeout(startNewCapture, 200); // 200ms delay to let Chrome cleanly free hardware
        });
      } else {
        startNewCapture();
      }
    });
    return true; // Keep response channel open for async response
  } else if (message.type === 'stop-capture') {
    stopCapture()
      .then(() => sendResponse({ success: true }))
      .catch((err) => sendResponse({ success: false, error: err.message }));
    return true;
  } else if (message.type === 'stream-ended-naturally') {
    stopCapture().catch(() => {});
  } else if (message.type === 'check-active-capture') {
    const queryTabId = message.tabId || activeTabId;
    chrome.tabCapture.getCapturedTabs((capturedTabs) => {
      const activeTab = (capturedTabs || []).find(
        (t) => t.tabId === queryTabId && (t.status === 'active' || t.status === 'pending')
      );
      if (activeTab) {
        activeTabId = queryTabId;
        sendResponse({ activeTabId: queryTabId });
      } else {
        // If the current tab has no active capture in the browser, clean up background states
        if (queryTabId === activeTabId || activeTabId === null) {
          activeTabId = null;
          chrome.offscreen.hasDocument().then((hasDoc) => {
            if (hasDoc) {
              chrome.offscreen.closeDocument().catch(() => {});
            }
          }).catch(() => {});
        }
        sendResponse({ activeTabId: null });
      }
    });
    return true; // Keep response channel open for async response
  }
});

// Helper to setup and open offscreen document
async function setupOffscreenDocument(streamId, tabId, settings) {
  const hasDoc = await chrome.offscreen.hasDocument().catch(() => false);
  if (!hasDoc) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA'],
      justification: 'Sonaura: Capture and enhance tab audio using Web Audio API'
    });
    // Wait a brief moment for the offscreen context to initialize
    await new Promise(r => setTimeout(r, 100));
  }
  
  // Send message and wait for it to complete the capture setup in offscreen
  const response = await new Promise((resolve) => {
    chrome.runtime.sendMessage({
      type: 'start-audio-process',
      target: 'offscreen',
      streamId,
      tabId,
      settings
    }, (res) => {
      resolve(res);
    });
  });
  
  if (!response || !response.success) {
    throw new Error((response && response.error) || "Failed to initialize offscreen audio process.");
  }
}

async function stopCapture() {
  const hasDoc = await chrome.offscreen.hasDocument().catch(() => false);
  if (hasDoc) {
    try {
      // Wait for offscreen document to release audio capture tracks
      await chrome.runtime.sendMessage({
        type: 'stop-audio-process',
        target: 'offscreen'
      });
    } catch (e) {
      console.warn("Sonaura: Offscreen already closed or unreachable", e);
    }
    // Wait for document to close completely
    await chrome.offscreen.closeDocument().catch(() => {});
  }
  activeTabId = null;
}

// Clean up if the captured tab is closed
chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === activeTabId) {
    stopCapture().catch((e) => console.error("Sonaura: Error stopping on tab close", e));
  }
});



// Removed onUpdated listener to prevent seeking/pausing from stopping capture.

