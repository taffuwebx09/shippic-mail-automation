const TARGET_SPACE_NAME = "SHIP PIC3";
const MAX_FOLLOWING_MESSAGES = 5000;
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
  const lookupStartedAt = Date.now();
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

  // SEARCH_MESSAGES_VIEW_FULL already returns the complete Message resource.
  // Reuse it directly instead of making another round-trip for every result.
  for (const occurrence of matches) {
    const directImage = imageAttachment(occurrence);
    if (directImage) {
      const photo = await downloadMessageImage(token, directImage);
      return {
        imageDataUrl: photo,
        waybill,
        durationMs: Date.now() - lookupStartedAt,
        message: "Shipment photo retrieved from the waybill message in SHIP PIC3."
      };
    }

    const candidate = await findFollowingImageInSpace(token, space.name, occurrence, waybill);
    if (candidate) {
      const photo = await downloadMessageImage(token, candidate);
      return {
        imageDataUrl: photo,
        waybill,
        durationMs: Date.now() - lookupStartedAt,
        message: "Shipment photo retrieved from the first valid SHIP PIC3 timeline match."
      };
    }
  }

  throw new Error("Waybill was found in SHIP PIC3, but no downloadable image attachment was found before the next waybill message. Confirm the photo is uploaded directly in Chat or is an accessible Drive file.");
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
        pageSize: 25,
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

async function findFollowingImageInSpace(token, spaceName, occurrence, waybill) {
  if (!occurrence.createTime) throw new Error("Google Chat returned a waybill message without a creation timestamp.");

  // Do not impose an arbitrary 10-minute cutoff. Walk forward in chronological
  // pages until the next waybill boundary or the first image attachment.
  let pageToken = "";
  let scanned = 0;
  do {
    const data = await chatApi(token, spaceName + "/messages", {
      pageSize: "25",
      filter: 'createTime > "' + occurrence.createTime + '"',
      pageToken
    });

    const messages = data.messages || [];
    scanned += messages.length;
    if (scanned > MAX_FOLLOWING_MESSAGES) {
      throw new Error("The waybill was found, but more than " + MAX_FOLLOWING_MESSAGES + " later messages appeared before a photo or next waybill. No potentially wrong photo was selected.");
    }
    for (const message of messages) {
      if (message.name === occurrence.name) continue;

      // Repeated appearances of the same target waybill are not a boundary.
      // A different waybill is a hard stop, even if that message has an image.
      if (hasDifferentWaybill(message, waybill)) return null;

      const attachment = imageAttachment(message);
      if (attachment) return attachment;
    }

    if (!data.nextPageToken) return null;
    // Avoid silently scanning an unbounded space when no next waybill is present.
    if (messages.length === 0) return null;
    pageToken = data.nextPageToken || "";
  } while (pageToken);

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
  const cachedSpaceName = await getCachedSpaceName();
  if (cachedSpaceName) {
    return { name: cachedSpaceName, displayName: TARGET_SPACE_NAME };
  }

  let pageToken = "";
  do {
    const data = await chatApi(token, "spaces", { pageSize: "1000", pageToken });
    const spaces = data.spaces || [];
    const match = spaces.find((space) => String(space.displayName || "").trim().toLocaleUpperCase() === TARGET_SPACE_NAME);
    if (match) {
      await cacheSpaceName(match.name);
      return match;
    }
    pageToken = data.nextPageToken || "";
  } while (pageToken);
  return null;
}



function getCachedSpaceName() {
  return new Promise((resolve) => {
    if (!chrome.storage?.local) return resolve("");
    chrome.storage.local.get(["shippicTargetSpaceName"], (items) => {
      if (chrome.runtime.lastError) return resolve("");
      resolve(String(items?.shippicTargetSpaceName || ""));
    });
  });
}

function cacheSpaceName(spaceName) {
  return new Promise((resolve) => {
    if (!chrome.storage?.local) return resolve();
    chrome.storage.local.set({ shippicTargetSpaceName: spaceName }, () => resolve());
  });
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

function extractWaybills(message) {
  const values = [];
  const pattern = /(?:^|\D)(\d{8,25})(?=\D|$)/g;
  const text = messageText(message);
  let match;
  while ((match = pattern.exec(text)) !== null) values.push(match[1]);
  return values;
}

function hasDifferentWaybill(message, targetWaybill) {
  return extractWaybills(message).some((value) => value !== targetWaybill);
}

function imageAttachment(message) {
  // Google Chat REST Message schema uses "attachment" (singular array).
  // Accept "attachments" too for compatibility with older/mock payloads.
  const attachments = [
    ...(Array.isArray(message.attachment) ? message.attachment : []),
    ...(Array.isArray(message.attachments) ? message.attachments : [])
  ];

  return attachments.find((item) => {
    const contentType = String(item.contentType || "").toLowerCase();
    const fileName = String(item.contentName || "").toLowerCase();
    const looksLikeImage = contentType.startsWith("image/") ||
      /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(fileName);

    // Only accept attachments that have a supported downloadable data ref.
    return looksLikeImage && Boolean(
      item.attachmentDataRef?.resourceName ||
      item.driveDataRef?.driveFileId
    );
  }) || null;
}

async function downloadMessageImage(token, attachment) {
  let response;
  const chatResourceName = attachment.attachmentDataRef?.resourceName;
  const driveFileId = attachment.driveDataRef?.driveFileId;

  if (chatResourceName) {
    // Google Chat media.download accepts /v1/media/{+resourceName}?alt=media.
    const encodedResourceName = chatResourceName.split("/").map(encodeURIComponent).join("/");
    response = await fetch("https://chat.googleapis.com/v1/media/" + encodedResourceName + "?alt=media", {
      headers: { Authorization: "Bearer " + token, Accept: "*/*" }
    });
  } else if (driveFileId) {
    // Drive attachments are not downloadable through Chat media.download.
    const driveUrl = new URL("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(driveFileId));
    driveUrl.searchParams.set("alt", "media");
    driveUrl.searchParams.set("supportsAllDrives", "true");
    response = await fetch(driveUrl, {
      headers: { Authorization: "Bearer " + token, Accept: "*/*" }
    });
  } else {
    throw new Error("The image attachment has no downloadable Chat or Drive file reference. Attachment: " + (attachment.name || "unknown"));
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    if (response.status === 401) throw new Error("Google authorization expired while downloading the photo. Reload the extension and authorize again.");
    if (response.status === 403 && driveFileId) throw new Error("Google Drive denied access to the photo (403). Confirm the office account can open the file, Google Drive API is enabled, and the extension was re-authorized with drive.readonly scope.");
    throw new Error("Google could not download the matched image (" + response.status + "). " + detail.slice(0, 300));
  }

  const blob = await response.blob();
  const contentType = (blob.type && blob.type !== "application/octet-stream")
    ? blob.type
    : (attachment.contentType || "application/octet-stream");

  if (!contentType.toLowerCase().startsWith("image/")) {
    throw new Error("The matched attachment is not an image (" + contentType + ").");
  }
  if (!blob.size) throw new Error("Google returned an empty image file.");
  if (blob.size > MAX_IMAGE_BYTES) {
    throw new Error("Shipment photo exceeds the 12 MB website transfer limit.");
  }
  return blobToDataUrl(blob, contentType);
}

async function blobToDataUrl(blob, contentType) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const chunkSize = 0x8000;
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return "data:" + contentType + ";base64," + btoa(binary);
}
