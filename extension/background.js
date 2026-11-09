const CHAT_GROUP_URL = "https://chat.google.com/app/chat/AAAA88R6rOc";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SEARCH_WAYBILL") {
    const waybill = String(message.waybill || "").trim();
    if (!/^\d{8,25}$/.test(waybill)) {
      sendResponse({ error: "Please enter a valid waybill number." });
      return;
    }

    (async () => {
      try {
        const chatTabs = await chrome.tabs.query({ url: "https://chat.google.com/app/chat/*" });
        let chatTab = chatTabs.find((tab) => (tab.url || "").includes("AAAA88R6rOc"));
        if (!chatTab) {
          chatTab = await chrome.tabs.create({ url: CHAT_GROUP_URL, active: true });
          await waitForTab(chatTab.id);
        } else {
          await chrome.tabs.update(chatTab.id, { active: true });
        }
        await chrome.tabs.sendMessage(chatTab.id, { type: "FIND_SHIPMENT_IMAGE", waybill });
        sendResponse({ started: true });
      } catch (error) {
        sendResponse({ error: error?.message || "Could not connect to Google Chat. Open the SHIP PIC3 group and retry." });
      }
    })();
    return true;
  }

  if (message?.type === "SHIP_PIC_RESULT" || message?.type === "SHIP_PIC_ERROR") {
    chrome.tabs.query({ url: "https://shippic-mail-automation.vercel.app/*" }).then((tabs) => {
      for (const tab of tabs) if (tab.id) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    });
  }
});

function waitForTab(tabId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Google Chat did not finish loading in time."));
    }, 20000);
    const listener = (updatedId, info) => {
      if (updatedId === tabId && info.status === "complete") {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}
