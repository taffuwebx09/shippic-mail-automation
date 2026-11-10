const TARGET_SPACE_NAME = "SHIP PIC3";
const MAX_FOLLOWING_MESSAGES = 5000;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGES_PER_WAYBILL = 2;

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

  const matches = await searchWaybillMessages(token, waybill, space.name);
  if (!matches.length) {
    throw new Error("No message containing this exact waybill was found in SHIP PIC3. Check the number and confirm it appears as message text.");
  }

  matches.sort((a, b) => new Date(a.createTime || 0) - new Date(b.createTime || 0));

  for (const occurrence of matches) {
    // Start with every downloadable image attached to the exact waybill message.
    const directImages = imageAttachments(occurrence).slice(0, MAX_IMAGES_PER_WAYBILL);
    const candidates = directImages.length >= MAX_IMAGES_PER_WAYBILL
      ? directImages
      : await findFollowingImagesInSpace(token, space.name, occurrence, waybill, directImages);

    if (!candidates.length) continue;

    // Download at most two matched photos in parallel. Keep one successful
    // image even if the second attachment is inaccessible.
    const downloads = await Promise.allSettled(
      candidates.slice(0, MAX_IMAGES_PER_WAYBILL).map((attachment) => downloadMessageImage(token, attachment))
    );
    const imageDataUrls = downloads
      .filter((item) => item.status === "fulfilled")
      .map((item) => item.value);

    if (!imageDataUrls.length) {
      const firstFailure = downloads.find((item) => item.status === "rejected");
      throw new Error(firstFailure?.reason?.message || "The matched shipment photos could not be downloaded.");
    }

    const photoCount = imageDataUrls.length;
    return {
      imageDataUrls,
      imageDataUrl: imageDataUrls[0],
      waybill,
      durationMs: Date.now() - lookupStartedAt,
      message: photoCount === 1
        ? "1 shipment photo retrieved from SHIP PIC3."
        : photoCount + " shipment photos retrieved from SHIP PIC3."
    };
  }

  throw new Error("Waybill was found in SHIP PIC3, but no downloadable image attachment was found before the next different waybill message.");
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

async function findFollowingImagesInSpace(token, spaceName, occurrence, waybill, initialImages = []) {
  if (!occurrence.createTime) throw new Error("Google Chat returned a waybill message without a creation timestamp.");

  const found = [...initialImages].slice(0, MAX_IMAGES_PER_WAYBILL);
  const seen = new Set(found.map(attachmentIdentity));
  if (found.length >= MAX_IMAGES_PER_WAYBILL) return found;

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
      if (found.length) return found;
      throw new Error("The waybill was found, but more than " + MAX_FOLLOWING_MESSAGES + " later messages appeared before a photo or next waybill. No potentially wrong photo was selected.");
    }

    for (const message of messages) {
      if (message.name === occurrence.name) continue;

      // A different waybill is a hard boundary. Do not use any images after it.
      if (hasDifferentWaybill(message, waybill)) return found;

      for (const attachment of imageAttachments(message)) {
        const identity = attachmentIdentity(attachment);
        if (!seen.has(identity)) {
          found.push(attachment);
          seen.add(identity);
        }
        if (found.length >= MAX_IMAGES_PER_WAYBILL) return found;
      }
    }

    if (!data.nextPageToken || messages.length === 0) return found;
    pageToken = data.nextPageToken;
  } while (pageToken);

  return found;
}

// Backward-compatible helper for older callers/tests that expect one photo.
async function findFollowingImageInSpace(token, spaceName, occurrence, waybill) {
  const images = await findFollowingImagesInSpace(token, spaceName, occurrence, waybill);
  return images[0] || null;
}

function attachmentIdentity(attachment) {
  return attachment.attachmentDataRef?.resourceName ||
    attachment.driveDataRef?.driveFileId ||
    attachment.name ||
    attachment.contentName ||
    JSON.stringify(attachment);
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

function imageAttachments(message) {
  // Google Chat REST Message schema uses "attachment" (singular array).
  // Accept "attachments" too for compatibility with older/mock payloads.
  const attachments = [
    ...(Array.isArray(message.attachment) ? message.attachment : []),
    ...(Array.isArray(message.attachments) ? message.attachments : [])
  ];

  return attachments.filter((item) => {
    const contentType = String(item.contentType || "").toLowerCase();
    const fileName = String(item.contentName || "").toLowerCase();
    const looksLikeImage = contentType.startsWith("image/") ||
      /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/i.test(fileName);

    return looksLikeImage && Boolean(
      item.attachmentDataRef?.resourceName ||
      item.driveDataRef?.driveFileId
    );
  });
}

// Backward-compatible singular helper.
function imageAttachment(message) {
  return imageAttachments(message)[0] || null;
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
