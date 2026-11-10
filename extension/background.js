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
    throw new Error('Google Chat API could not find the named space "SHIP PIC3" for the authorized account. Confirm the office account is a member of that space.');
  }

  // Search the server-side Chat index for this exact waybill in SHIP PIC3.
  // This avoids downloading/paginating the entire 50k+ message history.
  const matches = await searchWaybillMessages(token, waybill, space.name);
  if (!matches.length) {
    throw new Error("No message containing this exact waybill was found in SHIP PIC3. Check the number and confirm it appears as message text.");
  }

  // Search API returns newest first by default. Sort ascending to preserve
  // the project's first-valid-occurrence rule.
  matches.sort((a, b) => new Date(a.createTime || 0) - new Date(b.createTime || 0));

  for (const occurrence of matches) {
    const directImage = imageAttachment(occurrence);
    if (directImage) {
      const photo = await downloadMessageImage(token, directImage);
      return { imageDataUrl: photo, waybill, message: "Shipment photo retrieved from the waybill message in SHIP PIC3." };
    }

    const following = await listMessagesAfterOccurrence(token, space.name, occurrence.createTime);
    // The inclusive timestamp filter can return the original message again.
    // Remove it so it cannot be mistaken for the next waybill boundary.
    const nextMessages = following.filter((message) => message.name !== occurrence.name);
    const timeline = [occurrence, ...nextMessages].sort((a, b) => new Date(a.createTime || 0) - new Date(b.createTime || 0));
    const candidate = findFollowingImage(timeline, waybill);
    if (candidate) {
      const photo = await downloadMessageImage(token, candidate);
      return { imageDataUrl: photo, waybill, message: "Shipment photo retrieved from the first valid SHIP PIC3 timeline match." };
    }
  }

  throw new Error("Waybill was found in SHIP PIC3, but no image was found before the next waybill message. Check whether the photo is posted as a separate image attachment.");
}

async function searchWaybillMessages(token, waybill, spaceName) {
  const results = [];
  let pageToken = "";
  do {
    const response = await fetch("https://chat.googleapis.com/v1/spaces/-/messages:search", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        filter: '"' + waybill + '" AND space.name = "' + spaceName + '"',
        pageSize: 100,
        view: "SEARCH_MESSAGES_VIEW_FULL",
        pageToken: pageToken || undefined
      })
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      let detail = body;
      try { detail = JSON.parse(body).error?.message || body; } catch {}
      if (response.status === 401) throw new Error("Google authorization expired. Reload the extension and authorize again.");
      if (response.status === 403) throw new Error("Google Chat message search denied (403). Check the office account's Chat access, OAuth scopes, and Workspace admin restrictions. " + detail);
      throw new Error("Google Chat message search error (" + response.status + "): " + detail);
    }
    const data = await response.json();
    for (const item of (data.results || [])) {
      if (item.message && containsWaybill(item.message, waybill)) results.push(item.message);
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken && results.length < 1000);

  return results;
}

async function listMessagesAfterOccurrence(token, spaceName, createTime) {
  if (!createTime) throw new Error("Google Chat returned a waybill message without a creation timestamp.");
  const start = new Date(createTime);
  const end = new Date(start.getTime() + 10 * 60 * 1000);
  const filter = 'createTime >= "' + start.toISOString() + '" AND createTime < "' + end.toISOString() + '"';
  const all = [];
  let pageToken = "";
  do {
    const data = await chatApi(token, spaceName + "/messages", {
      pageSize: "1000",
      filter,
      orderBy: "createTime ASC",
      pageToken
    });
    all.push(...(data.messages || []));
    if (all.length >= 2000) break;
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return all;
}

function findFollowingImage(timeline, waybill) {
  const occurrenceIndex = timeline.findIndex((message) => containsWaybill(message, waybill));
  if (occurrenceIndex < 0) return null;
  for (let i = occurrenceIndex + 1; i < timeline.length; i++) {
    if (hasAnyWaybill(timeline[i])) break;
    const attachment = imageAttachment(timeline[i]);
    if (attachment) return attachment;
  }
  return null;
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
