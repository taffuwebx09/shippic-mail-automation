const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "FIND_SHIPMENT_IMAGE") return;
  findShipmentImage(message.waybill)
    .then((result) => chrome.runtime.sendMessage({ type: "SHIP_PIC_RESULT", ...result, waybill: message.waybill }))
    .catch((error) => chrome.runtime.sendMessage({ type: "SHIP_PIC_ERROR", message: error.message, waybill: message.waybill }));
  sendResponse({ started: true });
  return true;
});

async function findShipmentImage(waybill) {
  await sleep(900);
  const searchBox = Array.from(document.querySelectorAll('input,[role="searchbox"],[contenteditable="true"]'))
    .find((el) => /search chat|search/i.test((el.getAttribute("placeholder") || "") + " " + (el.getAttribute("aria-label") || "")));

  if (!searchBox) throw new Error("Google Chat search box wasn't detected. Open SHIP PIC3 and retry.");

  searchBox.focus();
  if ("value" in searchBox) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(searchBox, waybill);
  } else {
    searchBox.textContent = waybill;
  }
  searchBox.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: waybill }));
  searchBox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  searchBox.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
  await sleep(1800);

  const matches = Array.from(document.querySelectorAll("body *"))
    .filter((el) => el.children.length === 0 && el.textContent?.trim() === waybill && el.getBoundingClientRect().width > 0)
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
  if (!matches.length) throw new Error("Exact waybill wasn't found in the visible Google Chat results.");

  for (const match of matches) {
    let node = match;
    for (let depth = 0; depth < 8 && node; depth++, node = node.parentElement) {
      const candidates = Array.from(node.querySelectorAll("img"))
        .filter((img) => img.complete && img.naturalWidth > 80 && img.naturalHeight > 80)
        .filter((img) => !/avatar|profile|emoji/i.test(img.alt || ""));
      if (candidates[0]) {
        return { imageDataUrl: await fetchImageDataUrl(candidates[0].currentSrc || candidates[0].src), message: "Image retrieved from the matching waybill result." };
      }
    }
  }
  throw new Error("Waybill matched, but its shipment photo wasn't found in the same message area.");
}

async function fetchImageDataUrl(url) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error("Google Chat attachment couldn't be retrieved (" + response.status + ").");
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("The matched attachment is not an image.");
  if (blob.size > 12 * 1024 * 1024) throw new Error("The shipment image exceeds the 12 MB limit.");
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not read the shipment image data."));
    reader.readAsDataURL(blob);
  });
}
