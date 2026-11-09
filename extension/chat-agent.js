/*
 * ShipPic background Google Chat agent.
 * Pairing rule: the requested waybill message is followed by its photo in the
 * SHIP PIC3 timeline. The photo may be posted by a different sender.
 */
const GROUP_NAME = "SHIP PIC3";
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
  waybill = String(waybill || "").trim().replace(/^'+/, "");
  if (!/^\d{8,25}$/.test(waybill)) throw new Error("Waybill format is invalid.");

  const searchBox = await waitForSearchBox();
  if (!searchBox) throw new Error("Google Chat search field was not detected. Keep Google Chat signed in and reload the extension.");

  setInput(searchBox, waybill);
  await sleep(250);
  pressEnter(searchBox);

  const resultRow = await waitForTargetGroupResult(waybill);
  if (!resultRow) {
    throw new Error("Google Chat search returned no exact result in SHIP PIC3. Check the waybill and make sure the SHIP PIC3 conversation is included in search.");
  }

  clickResult(resultRow);

  const messageAndImage = await waitForMessagePhoto(waybill);
  if (!messageAndImage) {
    throw new Error("Opened SHIP PIC3, but no photo was found below the exact waybill. The message may not have an image yet, or Chat did not load the nearby messages.");
  }

  const imageDataUrl = await fetchImageThroughExtension(messageAndImage.image.currentSrc || messageAndImage.image.src);
  return {
    imageDataUrl,
    message: "Shipment photo matched by timeline order in SHIP PIC3, regardless of sender."
  };
}

async function waitForSearchBox() {
  for (let i = 0; i < 40; i++) {
    const box = findSearchBox();
    if (box) return box;
    await sleep(250);
  }
  return null;
}

function findSearchBox() {
  const nodes = Array.from(document.querySelectorAll('input,[role="searchbox"],[contenteditable="true"]'));
  return nodes.find((el) => {
    const hint = [el.getAttribute("placeholder"), el.getAttribute("aria-label"), el.getAttribute("data-placeholder")].filter(Boolean).join(" ");
    return /search chat/i.test(hint) && visible(el);
  }) || nodes.find((el) => {
    const hint = [el.getAttribute("placeholder"), el.getAttribute("aria-label")].filter(Boolean).join(" ");
    return /^search$/i.test(hint.trim()) && visible(el);
  });
}

function setInput(el, value) {
  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
  } else {
    el.textContent = value;
  }
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function pressEnter(el) {
  for (const type of ["keydown", "keypress", "keyup"]) {
    el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  }
}

function normalized(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
}

function containsExactWaybill(el, waybill) {
  const text = normalized(el.innerText || el.textContent);
  return text.split(/\D+/).includes(waybill);
}

function hasTargetGroupAndWaybill(el, waybill) {
  const text = normalized(el.innerText || el.textContent);
  return text.includes(normalized(GROUP_NAME)) && containsExactWaybill(el, waybill);
}

async function waitForTargetGroupResult(waybill) {
  for (let attempt = 0; attempt < 60; attempt++) {
    const row = findTargetGroupResult(waybill);
    if (row) return row;
    await sleep(250);
  }
  return null;
}

function findTargetGroupResult(waybill) {
  const numberLeaves = Array.from(document.querySelectorAll("body *"))
    .filter((el) => el.children.length <= 2 && containsExactWaybill(el, waybill) && visible(el));

  const candidates = new Set();
  for (const leaf of numberLeaves) {
    let el = leaf;
    for (let depth = 0; depth < 14 && el && el !== document.body; depth++, el = el.parentElement) {
      if (!visible(el) || !hasTargetGroupAndWaybill(el, waybill)) continue;
      const rect = el.getBoundingClientRect();
      // Avoid treating the full search-results page as the selectable result.
      if (rect.width >= 170 && rect.width <= window.innerWidth * 0.99 && rect.height >= 32 && rect.height <= 650) {
        candidates.add(el);
      }
    }
  }

  const ranked = Array.from(candidates).map((el) => {
    const r = el.getBoundingClientRect();
    const role = el.getAttribute("role") || "";
    const semanticClick = /^(listitem|button|link|option)$/i.test(role) || el.hasAttribute("tabindex");
    return { el, area: r.width * r.height, semanticClick, textLength: normalized(el.innerText || el.textContent).length };
  }).sort((a, b) => Number(b.semanticClick) - Number(a.semanticClick) || a.area - b.area || a.textLength - b.textLength);

  return ranked[0]?.el || null;
}

function clickResult(el) {
  el.scrollIntoView({ block: "center", inline: "nearest" });
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  for (const type of ["mousedown", "mouseup", "click"]) {
    el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }));
  }
}

async function waitForMessagePhoto(waybill) {
  for (let attempt = 0; attempt < 70; attempt++) {
    const groupTitleVisible = normalized(document.body.innerText).includes(normalized(GROUP_NAME));
    if (groupTitleVisible) {
      const nodes = findExactWaybillNodes(waybill);
      for (const node of nodes) {
        node.scrollIntoView({ block: "center", inline: "nearest" });
        await sleep(120);
        const image = findPhotoFollowingWaybill(node, waybill);
        if (image) return { messageNode: node, image };
      }
    }
    await sleep(250);
  }
  return null;
}

function findExactWaybillNodes(waybill) {
  return Array.from(document.querySelectorAll("body *"))
    .filter((el) => el.children.length <= 2 && normalized(el.innerText || el.textContent) === waybill && visible(el))
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
}

function findPhotoFollowingWaybill(waybillNode, waybill) {
  const numberRect = waybillNode.getBoundingClientRect();
  const photos = getVisibleShipmentPhotos(document).map((img) => {
    const rect = img.getBoundingClientRect();
    return { img, top: rect.top, gap: rect.top - numberRect.bottom, left: rect.left };
  }).filter((photo) => photo.gap >= -24 && photo.gap <= 1600);

  // A different waybill between this number and a photo means that photo belongs
  // to the later shipment. Sender identity is intentionally not considered.
  const nextWaybillTop = Array.from(document.querySelectorAll("body *"))
    .filter((el) => el.children.length <= 2 && visible(el))
    .map((el) => ({ text: normalized(el.innerText || el.textContent), top: el.getBoundingClientRect().top }))
    .filter((item) => /^\d{8,25}$/.test(item.text) && item.text !== waybill && item.top > numberRect.bottom + 2)
    .reduce((min, item) => Math.min(min, item.top), Infinity);

  return photos
    .filter((photo) => photo.top < nextWaybillTop)
    .sort((a, b) => a.gap - b.gap)[0]?.img || null;
}

function getVisibleShipmentPhotos(root) {
  return Array.from(root.querySelectorAll("img"))
    .filter((img) => visible(img) && img.complete && img.naturalWidth > 80 && img.naturalHeight > 80)
    .filter((img) => !/avatar|profile|emoji|logo/i.test((img.alt || "") + " " + (img.getAttribute("aria-label") || "")));
}

function visible(el) {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

function fetchImageThroughExtension(url) {
  return new Promise((resolve, reject) => {
    if (!url || !/^https:\/\//i.test(url)) {
      reject(new Error("The matching photo has no supported HTTPS image URL."));
      return;
    }
    chrome.runtime.sendMessage({ type: "FETCH_SHIPPIC_IMAGE", url }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error("The extension could not retrieve the Google Chat photo: " + chrome.runtime.lastError.message));
      } else if (!response?.imageDataUrl) {
        reject(new Error(response?.error || "Google Chat photo transfer failed."));
      } else {
        resolve(response.imageDataUrl);
      }
    });
  });
}
