/*
 * SHIP PIC3 lookup running in the inactive Google Chat tab.
 * A search result is accepted only when its row contains BOTH the exact waybill
 * and the configured SHIP PIC3 group name. It then opens that row and transfers
 * the corresponding photo to the ShipPic website.
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
  waybill = String(waybill || "").trim();
  if (!/^\d{8,25}$/.test(waybill)) throw new Error("Waybill format is invalid.");

  await sleep(900);
  const searchBox = findSearchBox();
  if (!searchBox) throw new Error("Google Chat search field was not detected. Open Google Chat and keep your session signed in.");

  setInput(searchBox, waybill);
  await sleep(200);
  pressEnter(searchBox);

  // Important: only click a result row that names the target SHIP PIC3 group.
  const resultRow = await waitForTargetGroupResult(waybill);
  if (!resultRow) {
    throw new Error("Google Chat search completed, but I couldn't find a result row containing both this waybill and SHIP PIC3. The result may be hidden by a filter or Chat's DOM may have changed.");
  }

  clickResult(resultRow);

  // Wait for the selected conversation to render the actual message and its image.
  const messageAndImage = await waitForMessagePhoto(waybill);
  if (!messageAndImage) {
    throw new Error("The SHIP PIC3 result was opened, but the exact waybill's photo wasn't found in the conversation.");
  }

  return {
    imageDataUrl: await imageToDataUrl(messageAndImage.image.currentSrc || messageAndImage.image.src),
    message: "Photo fetched from the matching waybill in SHIP PIC3."
  };
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
    el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  }
}

function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim().toUpperCase();
}

function hasWaybillAndTargetGroup(element, waybill) {
  const text = normalizeText(element.innerText || element.textContent);
  return text.includes(waybill) && text.includes(normalizeText(GROUP_NAME));
}

async function waitForTargetGroupResult(waybill) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const row = findTargetGroupResult(waybill);
    if (row) return row;
    await sleep(250);
  }
  return null;
}

function findTargetGroupResult(waybill) {
  const leaves = Array.from(document.querySelectorAll("body *"))
    .filter((el) => el.children.length <= 2 && normalizeText(el.textContent).includes(waybill) && visible(el));

  const candidates = new Set();
  for (const leaf of leaves) {
    let current = leaf;
    for (let depth = 0; depth < 10 && current && current !== document.body; depth++, current = current.parentElement) {
      if (!visible(current)) continue;
      const rect = current.getBoundingClientRect();
      // A result card/row should be bounded. Exclude the whole results page.
      if (rect.height >= 38 && rect.height <= 520 && rect.width >= 180 && rect.width <= window.innerWidth * 0.98 &&
          hasWaybillAndTargetGroup(current, waybill)) {
        candidates.add(current);
      }
    }
  }

  return Array.from(candidates)
    .map((el) => ({ el, rect: el.getBoundingClientRect(), textLength: normalizeText(el.innerText || el.textContent).length }))
    // Favor the smallest container that still contains the group label and exact waybill.
    .sort((a, b) => (a.rect.height * a.rect.width) - (b.rect.height * b.rect.width) || a.textLength - b.textLength)[0]?.el || null;
}

function clickResult(el) {
  el.scrollIntoView({ block: "center", inline: "nearest" });
  // Google Chat commonly handles clicks through delegated events on the result row.
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, view: window }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true, view: window }));
  el.click();
}

async function waitForMessagePhoto(waybill) {
  for (let attempt = 0; attempt < 55; attempt++) {
    const exactNodes = findExactWaybillNodes(waybill);
    for (const messageNode of exactNodes) {
      const image = findImageBelowMessage(messageNode);
      if (image) return { messageNode, image };
    }
    await sleep(300);
  }
  return null;
}

function findExactWaybillNodes(waybill) {
  return Array.from(document.querySelectorAll("body *"))
    .filter((el) => el.children.length <= 2 && (el.innerText || el.textContent || "").trim() === waybill && visible(el))
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
}

function findImageBelowMessage(textNode) {
  const textRect = textNode.getBoundingClientRect();

  // Try compact ancestors first. This keeps the photo association local to this message.
  let root = textNode;
  for (let depth = 0; depth < 8 && root.parentElement; depth++) {
    root = root.parentElement;
    const images = getShipmentImages(root);
    const below = images
      .map((img) => ({ img, gap: img.getBoundingClientRect().top - textRect.bottom }))
      .filter(({ gap }) => gap >= -18 && gap <= 1250)
      .sort((a, b) => a.gap - b.gap)[0];
    if (below) return below.img;
    if (root.getBoundingClientRect().height > 1700) break;
  }

  // Fallback by geometry inside the conversation viewport.
  return getShipmentImages(document)
    .map((img) => {
      const rect = img.getBoundingClientRect();
      const gap = rect.top - textRect.bottom;
      const horizontal = Math.abs(rect.left - textRect.left);
      return { img, gap, horizontal, score: gap + horizontal * 0.12 };
    })
    .filter(({ gap, horizontal }) => gap >= -18 && gap <= 1250 && horizontal < Math.max(520, window.innerWidth * 0.45))
    .sort((a, b) => a.score - b.score)[0]?.img || null;
}

function getShipmentImages(root) {
  return Array.from(root.querySelectorAll("img"))
    .filter((img) => visible(img) && img.complete && img.naturalWidth > 80 && img.naturalHeight > 80)
    .filter((img) => !/avatar|profile|emoji|logo/i.test((img.alt || "") + " " + (img.getAttribute("aria-label") || "")));
}

function visible(el) {
  const rect = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
}

async function imageToDataUrl(url) {
  if (!url) throw new Error("The matching photo's image source is missing.");
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error("Google Chat image retrieval failed (" + response.status + ").");
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("The matched attachment is not an image.");
  if (blob.size > 12 * 1024 * 1024) throw new Error("The shipment image is larger than 12 MB.");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not convert the shipment photo for the website."));
    reader.readAsDataURL(blob);
  });
}
