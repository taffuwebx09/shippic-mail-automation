window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || data.source !== "shippic-web") return;

  if (data.type === "PING_EXTENSION") {
    window.postMessage({ source: "shippic-extension", type: "EXTENSION_READY", extensionVersion: chrome.runtime.getManifest().version }, window.location.origin);
    return;
  }

  if (data.type === "SEARCH_WAYBILL" && /^\d{8,25}$/.test(data.waybill || "")) {
    window.postMessage({ source: "shippic-extension", type: "SEARCH_STARTED", waybill: data.waybill }, window.location.origin);
    try {
      chrome.runtime.sendMessage({
        type: "SEARCH_WAYBILL",
        waybill: data.waybill,
        chatUrl: "https://chat.google.com/app/chat/AAAA88R6rOc"
      }, (response) => {
      if (chrome.runtime.lastError) {
        window.postMessage({ source: "shippic-extension", type: "SEARCH_ERROR", message: "Extension connection failed: " + chrome.runtime.lastError.message + ". Reload this website tab after reloading the extension." }, window.location.origin);
      } else if (response?.result?.imageDataUrl) {
        window.postMessage({
          source: "shippic-extension",
          type: "SEARCH_RESULT",
          waybill: data.waybill,
          imageDataUrl: response.result.imageDataUrl,
          message: response.result.message
        }, window.location.origin);
      } else if (response?.error) {
        window.postMessage({ source: "shippic-extension", type: "SEARCH_ERROR", message: response.error }, window.location.origin);
      } else {
        window.postMessage({ source: "shippic-extension", type: "SEARCH_ERROR", message: "The extension returned an empty response. Inspect the ShipPic service worker in chrome://extensions, then reload this website tab." }, window.location.origin);
      }
      });
    } catch (error) {
      window.postMessage({
        source: "shippic-extension",
        type: "SEARCH_ERROR",
        message: "Extension context was refreshed while this tab was open. Reload this website tab and retry."
      }, window.location.origin);
    }
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "SHIP_PIC_RESULT") {
    window.postMessage({ source: "shippic-extension", type: "SEARCH_RESULT", waybill: message.waybill, imageDataUrl: message.imageDataUrl, message: message.message }, window.location.origin);
  } else if (message?.type === "SHIP_PIC_ERROR") {
    window.postMessage({ source: "shippic-extension", type: "SEARCH_ERROR", message: message.message }, window.location.origin);
  }
});
