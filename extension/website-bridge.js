window.addEventListener("message", (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = event.data;
  if (!data || data.source !== "shippic-web") return;

  if (data.type === "PING_EXTENSION") {
    window.postMessage({ source: "shippic-extension", type: "EXTENSION_READY" }, window.location.origin);
    return;
  }

  if (data.type === "SEARCH_WAYBILL" && /^\d{8,25}$/.test(data.waybill || "")) {
    window.postMessage({ source: "shippic-extension", type: "SEARCH_STARTED", waybill: data.waybill }, window.location.origin);
    chrome.runtime.sendMessage({
      type: "SEARCH_WAYBILL",
      waybill: data.waybill,
      chatUrl: "https://chat.google.com/app/chat/AAAA88R6rOc"
    }, (response) => {
      if (chrome.runtime.lastError) {
        window.postMessage({ source: "shippic-extension", type: "SEARCH_ERROR", message: "Extension isn't responding. Check that it's enabled, then reload this page." }, window.location.origin);
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
      }
    });
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "SHIP_PIC_RESULT") {
    window.postMessage({ source: "shippic-extension", type: "SEARCH_RESULT", waybill: message.waybill, imageDataUrl: message.imageDataUrl, message: message.message }, window.location.origin);
  } else if (message?.type === "SHIP_PIC_ERROR") {
    window.postMessage({ source: "shippic-extension", type: "SEARCH_ERROR", message: message.message }, window.location.origin);
  }
});
