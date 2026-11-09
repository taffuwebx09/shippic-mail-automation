const CHAT_GROUP_URL = "https://chat.google.com/app/chat/AAAA88R6rOc";
const APP_URL = "https://shippic-mail-automation.vercel.app/";

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SEARCH_WAYBILL") {
    const waybill = String(message.waybill || "").trim().replace(/^'+/, "");
    if (!/^\d{8,25}$/.test(waybill)) {
      sendResponse({ error: "Please enter a valid waybill number." });
      return;
    }

    (async () => {
      try {
        const chatTabs = await chrome.tabs.query({ url: "https://chat.google.com/app/chat/*" });

        /*
         * Never automate the user's currently visible Chat tab. Reuse a
         * non-active SHIP PIC3 tab if available; otherwise create a dedicated
         * inactive tab. This avoids changing the foreground Chat conversation
         * while the user stays on ShipPic.
         */
        let chatTab = chatTabs.find((tab) =>
          !tab.active && (tab.url || "").includes("AAAA88R6rOc")
        );

        if (!chatTab) {
          chatTab = await chrome.tabs.create({ url: CHAT_GROUP_URL, active: false });
          await waitForTab(chatTab.id);
        }

        // Explicitly preserve inactive status before running the content agent.
        await chrome.tabs.sendMessage(chatTab.id, { type: "FIND_SHIPMENT_IMAGE", waybill });
        sendResponse({ started: true, background: true });
      } catch (error) {
        sendResponse({ error: error?.message || "Could not connect to Google Chat. Check your sign-in and extension." });
      }
    })();
    return true;
  }

  if (message?.type === "FETCH_SHIPPIC_IMAGE") {
    fetchImageDataUrl(message.url)
      .then((imageDataUrl) => sendResponse({ imageDataUrl }))
      .catch((error) => sendResponse({ error: error.message || "Image fetch failed." }));
    return true;
  }

  if (message?.type === "SHIP_PIC_RESULT" || message?.type === "SHIP_PIC_ERROR") {
    chrome.tabs.query({ url: APP_URL + "*" }).then((tabs) => {
      for (const tab of tabs) if (tab.id) chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    });
  }
});

async function fetchImageDataUrl(rawUrl) {
  const url = new URL(rawUrl);
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || !(host === "googleusercontent.com" || host.endsWith(".googleusercontent.com") || host === "gstatic.com" || host.endsWith(".gstatic.com"))) {
    throw new Error("Blocked an image URL outside Google's approved image hosts.");
  }
  const response = await fetch(url.href, { credentials: "include", redirect: "follow" });
  if (!response.ok) throw new Error("Google Chat image returned HTTP " + response.status + ".");
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("The selected attachment is not an image.");
  if (blob.size > 12 * 1024 * 1024) throw new Error("Shipment photo is over the 12 MB limit.");

  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return "data:" + blob.type + ";base64," + btoa(binary);
}

async function waitForTab(tabId) {
  const existing = await chrome.tabs.get(tabId);
  if (existing.status === "complete") return;

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("Google Chat background tab did not finish loading in time."));
    }, 25000);
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
