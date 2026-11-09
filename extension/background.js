const APP_URL = "https://shippic-mail-automation.vercel.app/";
const TARGET_SPACE_NAME = "SHIP PIC3";
const MAX_MESSAGES_TO_SCAN = 50000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "SEARCH_WAYBILL") {
    const waybill = String(message.waybill || "").trim().replace(/^'+/, "");
    if (!/^\d{8,25}$/.test(waybill)) {
      sendResponse({ error: "Please enter a valid waybill number." });
      return;
    }

    lookupShipmentPhoto(waybill)
      .then((result) => sendResponse({ started: true, result }))
      .catch((error) => sendResponse({ error: error?.message || "Google Chat lookup failed." }));
    return true;
  }
});

async function lookupShipmentPhoto(waybill) {
  const token = await getOfficeAccountToken();
  const space = await findTargetSpace(token);
  if (!space) {
    throw new Error('Google Chat API could not find the named space "SHIP PIC3" for the authorized account. Confirm the office account is the Chrome profile primary account and is a member of that space.');
  }

  const messages = await listAllMessages(token, space.name);
  if (!messages.length) throw new Error("SHIP PIC3 is accessible, but it contains no readable messages.");

  const targetIndex = findFirstValidOccurrence(messages, waybill);
  if (!targetIndex) {
    throw new Error("No valid photo match found for this waybill in SHIP PIC3. Checked the exact waybill occurrences and the following timeline messages.");
  }

  const candidate = targetIndex;
  const photo = await downloadMessageImage(token, candidate.attachment);
  return {
    imageDataUrl: photo,
    waybill,
    message: "Shipment photo retrieved from the first valid SHIP PIC3 timeline match."
  };
}

function getOfficeAccountToken() {
  return new Promise((resolve, reject) => {
    if (!chrome.identity?.getAuthToken) {
      reject(new Error("Chrome Identity API is unavailable. Reload the extension from chrome://extensions and try again."));
      return;
    }
    chrome.identity.getAuthToken({ interactive: true }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error("Google authorization failed: " + chrome.runtime.lastError.message));
      } else if (!token) {
        reject(new Error("Google did not return an access token. Check that the office account is signed in to this Chrome profile."));
      } else {
        resolve(token);
      }
    });
  });
}

async function chatApi(token, path, params = {}) {
  const url = new URL("https://chat.googleapis.com/v1/" + path.replace(/^\//, ""));
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: { Authorization: "Bearer " + token, Accept: "application/json" }
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    let detail = body;
    try {
      const parsed = JSON.parse(body);
      detail = parsed.error?.message || body;
    } catch {}
    if (response.status === 401) {
      throw new Error("Google authorization expired or belongs to another account. Reload the extension and authorize again with the office account.");
    }
    if (response.status === 403) {
      throw new Error("Google Chat API access denied (403). The office account may lack access, Workspace admin approval may be required, or OAuth scopes may not be granted. Details: " + detail);
    }
    throw new Error("Google Chat API error (" + response.status + "): " + detail);
  }
  return response.json();
}

async function findTargetSpace(token) {
  let pageToken = "";
  do {
    const data = await chatApi(token, "spaces", { pageSize: "1000", pageToken });
    const spaces = data.spaces || [];
    const match = spaces.find((space) => String(space.displayName || "").trim().toLocaleUpperCase() === TARGET_SPACE_NAME);
    if (match) return match;
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return null;
}

async function listAllMessages(token, spaceName) {
  const all = [];
  let pageToken = "";
  do {
    const data = await chatApi(token, spaceName + "/messages", {
      pageSize: "1000",
      pageToken
    });
    all.push(...(data.messages || []));
    if (all.length > MAX_MESSAGES_TO_SCAN) {
      throw new Error("SHIP PIC3 has more than " + MAX_MESSAGES_TO_SCAN + " messages. Narrowing the scan safely needs a date range; no partial match was used.");
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return all;
}

function messageText(message) {
  return String(message.text || message.formattedText || "")
    .replace(/<[^>]*>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsWaybill(message, waybill) {
  const text = messageText(message);
  return text.split(/\D+/).includes(waybill);
}

function hasAnyWaybill(message) {
  return /(?:^|\D)\d{8,25}(?:\D|$)/.test(messageText(message));
}

function imageAttachment(message) {
  const attachments = Array.isArray(message.attachments) ? message.attachments : [];
  return attachments.find((item) =>
    String(item.contentType || "").toLowerCase().startsWith("image/") &&
    item.attachmentDataRef?.resourceName
  );
}

function findFirstValidOccurrence(messages, waybill) {
  for (let i = 0; i < messages.length; i++) {
    if (!containsWaybill(messages[i], waybill)) continue;

    // An image attached to the waybill message itself is a valid match.
    const sameMessageImage = imageAttachment(messages[i]);
    if (sameMessageImage) return { index: i, attachment: sameMessageImage };

    // Otherwise inspect following messages in timeline order. A different
    // shipment number is a hard boundary, regardless of who posted it.
    for (let j = i + 1; j < messages.length; j++) {
      if (hasAnyWaybill(messages[j])) break;
      const attachment = imageAttachment(messages[j]);
      if (attachment) return { index: j, attachment };
    }
  }
  return null;
}

async function downloadMessageImage(token, attachment) {
  const resourceName = attachment.attachmentDataRef.resourceName;
  const url = "https://chat.googleapis.com/v1/media/" +
    resourceName.split("/").map(encodeURIComponent).join("/") + "?alt=media";
  const response = await fetch(url, {
    headers: { Authorization: "Bearer " + token }
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error("Google Chat found the matching image attachment but could not download it (" +
      response.status + "). " + detail.slice(0, 300));
  }
  const blob = await response.blob();
  const contentType = blob.type || attachment.contentType || "";
  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error("The matched Chat attachment is not an image (" + contentType + ").");
  }
  if (blob.size > MAX_IMAGE_BYTES) {
    throw new Error("Shipment photo exceeds the 12 MB website transfer limit.");
  }
  return blobToDataUrl(blob, contentType);
}

function blobToDataUrl(blob, contentType) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Could not convert the shipment image for the website."));
    reader.readAsDataURL(new Blob([blob], { type: contentType }));
  });
}
