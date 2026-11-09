/*
 * ShipPic Google Chat automation.
 * Flow: focus Chat search -> fill waybill -> submit automatically -> wait for results
 * -> identify the exact waybill -> locate the image immediately below it -> return image bytes.
 *
 * Google Chat is a dynamic UI; selectors and message grouping can change. The script
 * uses visible DOM + geometric association rather than assuming the image is inside
 * the same text node's parent.
 */
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
  if (!/^\d{8,25}$/.test(String(waybill || ""))) throw new Error("Waybill format is invalid.");
  await waitForChatReady();

  const searchBox = findChatSearchBox();
  if (!searchBox) {
    throw new Error("Could not find Google Chat's Search chat field. Open SHIP PIC3 in Chat and retry.");
  }

  fillSearchBox(searchBox, waybill);
  await sleep(250);

  // Submit by keyboard and click the visible search action as a fallback when Chat's
  // UI intercepts synthetic keyboard events.
  searchBox.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  searchBox.dispatchEvent(new KeyboardEvent("keypress", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  searchBox.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));

  await waitForSearchResults(waybill);

  const matches = findExactWaybillNodes(waybill);
  if (!matches.length) {
    throw new Error("Search was submitted automatically, but no exact waybill result appeared. Check the Chat search result and try once more.");
  }

  const photo = findPhotoImmediatelyAfter(matches);
  if (!photo) {
    throw new Error("The exact waybill was found, but its photo below the message could not be identified. This Chat result layout needs selector tuning.");
  }

  const imageDataUrl = await fetchImageDataUrl(photo.currentSrc || photo.src);
  return { imageDataUrl, message: "Shipment image associated with the exact waybill was transferred to the website." };
}

async function waitForChatReady() {
  for (let i = 0; i < 30; i++) {
    if (document.readyState !== "loading" && findChatSearchBox()) return;
    await sleep(300);
  }
}

function findChatSearchBox() {
  const candidates = Array.from(document.querySelectorAll('input,[role="searchbox"],[contenteditable="true"]'));
  return candidates.find((el) => {
    const hint = (el.getAttribute("placeholder") || "") + " " + (el.getAttribute("aria-label") || "") + " " + (el.getAttribute("data-placeholder") || "");
    const rect = el.getBoundingClientRect();
    return /search chat/i.test(hint) && rect.width > 0 && rect.height > 0;
  }) || candidates.find((el) => {
    const hint = (el.getAttribute("placeholder") || "") + " " + (el.getAttribute("aria-label") || "");
    const rect = el.getBoundingClientRect();
    return /^search$/i.test(hint.trim()) && rect.width > 0 && rect.height > 0;
  });
}

function fillSearchBox(element, value) {
  element.focus();
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(element, value);
    else element.value = value;
  } else {
    element.textContent = value;
    element.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertText", data: value }));
  }
  element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

async function waitForSearchResults(waybill) {
  // Wait up to ~9 seconds for exact result text; Google Chat can take a moment.
  for (let i = 0; i < 30; i++) {
    if (findExactWaybillNodes(waybill).length) {
      await sleep(650); // allow attachment thumbnails to render
      return;
    }
    await sleep(300);
  }
}

function findExactWaybillNodes(waybill) {
  return Array.from(document.querySelectorAll("body *"))
    .filter((el) => el.children.length === 0 && el.textContent?.trim() === waybill)
    .filter(isVisible)
    .sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      return ra.top - rb.top || ra.left - rb.left;
    });
}

function isVisible(element) {
  const rect = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function findPhotoImmediatelyAfter(matches) {
  const images = Array.from(document.querySelectorAll("img"))
    .filter((img) => isVisible(img) && img.complete && img.naturalWidth > 80 && img.naturalHeight > 80)
    .filter((img) => !/avatar|profile|emoji|logo/i.test(img.alt || ""))
    .filter((img) => !/avatar|profile|emoji/i.test(img.getAttribute("aria-label") || ""));

  let best = null;
  let bestScore = Infinity;

  for (const match of matches) {
    const textRect = match.getBoundingClientRect();
    for (const img of images) {
      const imageRect = img.getBoundingClientRect();
      const verticalGap = imageRect.top - textRect.bottom;
      // User's established Chat pattern is waybill text followed by the photo.
      if (verticalGap < -12 || verticalGap > 1800) continue;

      const horizontalDistance = Math.abs((imageRect.left + imageRect.width / 2) - (textRect.left + textRect.width / 2));
      // Keep the candidate in the same side/column of the Chat conversation.
      if (horizontalDistance > Math.max(650, window.innerWidth * 0.55)) continue;

      // Prefer the closest image below the waybill; small horizontal mismatch is secondary.
      const score = verticalGap + horizontalDistance * 0.18;
      if (score < bestScore) {
        best = img;
        bestScore = score;
      }
    }
  }
  return best;
}

async function fetchImageDataUrl(url) {
  if (!url) throw new Error("The matching Chat image URL was empty.");
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error("Google Chat image retrieval failed (" + response.status + ").");
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("The selected Chat attachment is not an image.");
  if (blob.size > 12 * 1024 * 1024) throw new Error("The shipment image is larger than 12 MB.");
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not convert the shipment image for the website."));
    reader.readAsDataURL(blob);
  });
}
