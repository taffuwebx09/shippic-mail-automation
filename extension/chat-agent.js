/*
 * ShipPic Google Chat automation.
 * Runs in an inactive Chat tab. Searches the waybill, opens the matching search
 * conversation in that background tab, then extracts the photo below the waybill.
 * Google Chat's markup changes often, so this is intentionally DOM-driven and needs
 * a live test against the user's tenant.
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
  await wait(1200);

  let searchBox = findSearchBox();
  if (!searchBox) throw new Error("Google Chat search field was not detected in the background tab.");

  setInput(searchBox, waybill);
  await sleep(250);
  pressEnter(searchBox);

  // First result view is often the Conversations list. Click the result row whose
  // snippet includes this exact waybill to enter the related group/message.
  const resultRow = await waitForConversationResult(waybill);
  if (resultRow) {
    clickLikeUser(resultRow);
    await sleep(1400);
  }

  // Wait for the conversation message and its attachment thumbnail to render.
  const messageNode = await waitForExactMessage(waybill);
  if (!messageNode) {
    throw new Error("Google Chat search returned the waybill, but its message did not load in the conversation.");
  }

  const image = findImageAfterMessage(messageNode);
  if (!image) {
    throw new Error("The waybill message opened, but its shipment photo wasn't detected below it.");
  }
  return {
    imageDataUrl: await imageToDataUrl(image.currentSrc || image.src),
    message: "Shipment photo retrieved from the matching SHIP PIC3 message."
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
    setter ? setter.call(el, value) : (el.value = value);
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

async function waitForConversationResult(waybill) {
  for (let i = 0; i < 35; i++) {
    const leaf = Array.from(document.querySelectorAll("body *"))
      .filter((el) => el.children.length === 0 && el.textContent?.includes(waybill) && visible(el))
      .find((el) => {
        const ancestor = el.closest('[role="listitem"],[role="option"],[role="button"],a') || clickableAncestor(el);
        return ancestor && ancestor !== document.body;
      });
    if (leaf) {
      const row = leaf.closest('[role="listitem"],[role="option"],[role="button"],a') || clickableAncestor(leaf);
      if (row) return row;
    }
    await sleep(300);
  }
  return null;
}

function clickableAncestor(el) {
  let current = el;
  for (let i = 0; i < 8 && current && current !== document.body; i++, current = current.parentElement) {
    if (current.getAttribute("role") === "button" || current.getAttribute("role") === "link" ||
        current.hasAttribute("tabindex") || current.tagName === "A" || current.onclick) return current;
  }
  // Search result rows in Chat are often divs without semantic roles. Return a compact
  // parent that contains the matching snippet, not a large page-level container.
  current = el;
  for (let i = 0; i < 5 && current?.parentElement; i++, current = current.parentElement) {
    if (current.getBoundingClientRect().height > 35 && current.getBoundingClientRect().height < 260) return current;
  }
  return null;
}

function clickLikeUser(el) {
  el.scrollIntoView({ block: "center", inline: "nearest" });
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, view: window }));
  el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, view: window }));
  el.click();
}

async function waitForExactMessage(waybill) {
  for (let i = 0; i < 45; i++) {
    const nodes = exactWaybillNodes(waybill);
    if (nodes.length) {
      // Give Google Chat attachment thumbnails time to load after the message appears.
      await sleep(850);
      return nodes[0];
    }
    await sleep(300);
  }
  return null;
}

function exactWaybillNodes(waybill) {
  return Array.from(document.querySelectorAll("body *"))
    .filter((el) => el.children.length === 0 && el.textContent?.trim() === waybill && visible(el))
    .sort((a, b) => a.getBoundingClientRect().top - b.getBoundingClientRect().top);
}

function findImageAfterMessage(textNode) {
  // Prefer images in the nearest compact message container.
  let root = textNode;
  for (let depth = 0; depth < 7 && root.parentElement; depth++) {
    root = root.parentElement;
    const imgs = validImages(root);
    const nearestBelow = imgs
      .map((img) => ({ img, gap: img.getBoundingClientRect().top - textNode.getBoundingClientRect().bottom }))
      .filter(({ gap }) => gap >= -20 && gap < 1400)
      .sort((a, b) => a.gap - b.gap)[0];
    if (nearestBelow) return nearestBelow.img;
    if (root.getBoundingClientRect().height > 1500) break;
  }

  // Fallback: nearby image geometry within the visible conversation area.
  const textRect = textNode.getBoundingClientRect();
  return validImages(document)
    .map((img) => {
      const rect = img.getBoundingClientRect();
      const gap = rect.top - textRect.bottom;
      const horizontal = Math.abs(rect.left - textRect.left);
      return { img, gap, horizontal, score: gap + horizontal * 0.2 };
    })
    .filter(({ gap, horizontal }) => gap >= -20 && gap < 1500 && horizontal < Math.max(700, innerWidth * 0.6))
    .sort((a, b) => a.score - b.score)[0]?.img || null;
}

function validImages(root) {
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
  if (!url) throw new Error("Image source is missing.");
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) throw new Error("Could not retrieve the Chat image (" + response.status + ").");
  const blob = await response.blob();
  if (!blob.type.startsWith("image/")) throw new Error("The retrieved attachment is not an image.");
  if (blob.size > 12 * 1024 * 1024) throw new Error("The shipment image is over the 12 MB limit.");
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not convert the shipment photo for the website."));
    reader.readAsDataURL(blob);
  });
}
