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
  // Chat search results are rendered asynchronously. Poll quickly, but keep a
  // reasonable ceiling for slower RPC/Google Chat connections.
  for (let attempt = 0; attempt < 70; attempt++) {
    const row = findTargetGroupResult(waybill);
    if (row) return row;
    await sleep(150);
  }
  return null;
}

function findTargetGroupResult(waybill) {
  const numberLeaves = Array.from(document.querySelectorAll("body *"))
    .filter((el) => el.children.length <= 2 && containsExactWaybill(el, waybill) && visible(el));

  const candidates = new Set();
  for (const leaf of numberLeaves) {
    let el = leaf;
    for (let depth = 0; depth < 12 && el && el !== document.body; depth++, el = el.parentElement) {
      if (!visible(el) || !hasTargetGroupAndWaybill(el, waybill)) continue;
      const rect = el.getBoundingClientRect();
      // Candidate must look like one result card, not the complete result list.
      if (rect.width >= 170 && rect.width <= window.innerWidth * 0.99 &&
          rect.height >= 32 && rect.height <= 480) {
        candidates.add(el);
      }
    }
  }

  /*
   * Google Chat can return multiple SHIP PIC3 hits (including repeated posts).
   * Pick the first result in the visible result-list order (top-to-bottom).
   * Within that same row, prefer the semantic clickable node and then the
   * smallest bounded wrapper. Other groups and later duplicate hits are ignored.
   */
  const ranked = Array.from(candidates).map((el) => {
    const r = el.getBoundingClientRect();
    const role = el.getAttribute("role") || "";
    const semanticClick = /^(listitem|button|link|option)$/i.test(role) || el.hasAttribute("tabindex");
    return { el, top: r.top, left: r.left, area: r.width * r.height, semanticClick,
      textLength: normalized(el.innerText || el.textContent).length };
  }).sort((a, b) =>
    a.top - b.top ||
    a.left - b.left ||
    Number(b.semanticClick) - Number(a.semanticClick) ||
    a.area - b.area ||
    a.textLength - b.textLength
  );

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
  // The Chat conversation can render the text before the attachment image.
  // Check frequently for a fast response while allowing lazy-loaded images time.
  for (let attempt = 0; attempt < 90; attempt++) {
    if (normalized(document.body.innerText).includes(normalized(GROUP_NAME))) {
      const nodes = findExactWaybillNodes(waybill);
      for (const node of nodes) {
        node.scrollIntoView({ block: "center", inline: "nearest" });
        const image = findPhotoFollowingWaybill(node, waybill);
        if (image) return { messageNode: node, image };
      }
    }
    await sleep(150);
  }
  return null;
}

function findExactWaybillNodes(waybill) {
  return Array.from(document.querySelectorAll("body *"))
    .filter((el) => el.children.length <= 2 && normalized(el.innerText || el.textContent) === waybill && visible(el))
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
}

function findPhotoFollowingWaybill(waybillNode, waybill) {
  /*
   * Pair by message/timeline DOM order, NOT sender identity or screen position.
   * In SHIP PIC3, the shipment number is posted first and the evidence photo
   * follows it. The image may be posted by another member of the group.
   */
  const allShipmentNumbers = findShipmentNumberNodes();
  const followingNumbers = allShipmentNumbers.filter((node) =>
    isDomAfter(waybillNode, node) && normalized(node.textContent) !== waybill
  );

  const photos = getVisibleShipmentPhotos(document);
  const followingPhotos = photos.filter((img) => isDomAfter(waybillNode, img));

  // The next shipment-number message is a hard boundary: never steal its photo.
  for (const photo of followingPhotos) {
    const nextNumberBeforePhoto = followingNumbers.some((numberNode) =>
      isDomAfter(waybillNode, numberNode) && isDomAfter(numberNode, photo)
    );
    if (!nextNumberBeforePhoto) {
      // Keep the image association anchored to the message's DOM order.
      return photo;
    }
    // The first following photo belongs after another waybill: stop this match.
    return null;
  }
  return null;
}

function isDomAfter(anchor, candidate) {
  if (!anchor || !candidate || anchor === candidate) return false;
  return Boolean(anchor.compareDocumentPosition(candidate) & Node.DOCUMENT_POSITION_FOLLOWING);
}

function findShipmentNumberNodes() {
  const candidates = Array.from(document.querySelectorAll("body *"))
    .filter((el) => visible(el) && /^\\d{8,25}$/.test(normalized(el.textContent)));

  // Prefer the smallest text-bearing node; discard wrapper duplicates.
  return candidates.filter((el) => !Array.from(el.children).some((child) =>
    /^\\d{8,25}$/.test(normalized(child.textContent))
  ));
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
