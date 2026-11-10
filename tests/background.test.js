import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { URL } from "node:url";
import { Blob } from "node:buffer";

const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

function loadBackground(fetchImpl = async () => { throw new Error("Unexpected fetch"); }) {
  const context = {
    chrome: {
      runtime: { onMessage: { addListener() {} }, lastError: null },
      identity: { getAuthToken: (_options, callback) => callback("test-token") },
      storage: { local: { get: (_keys, callback) => callback({}), set: (_values, callback) => callback?.() } }
    },
    URL,
    Blob,
    Uint8Array,
    btoa,
    fetch: fetchImpl
  };
  vm.createContext(context);
  vm.runInContext(source + `
    globalThis.__test = {
      imageAttachment,
      imageAttachments,
      findFollowingImagesInSpace,
      containsWaybill,
      findFollowingImageInSpace,
      hasDifferentWaybill,
      blobToDataUrl,
      downloadMessageImage,
      lookupShipmentPhoto,
      findTargetSpace
    };
  `, context);
  return context.__test;
}

const targetWaybill = "14931338241691";
const uploadedImage = {
  name: "spaces/ship-pic3/messages/photo-1/attachments/abc",
  contentType: "image/jpeg",
  contentName: "shipment.jpg",
  source: "UPLOADED_CONTENT",
  attachmentDataRef: { resourceName: "spaces/ship-pic3/messages/photo-1/attachments/abc" }
};

test("detects Google Chat's singular attachment array", () => {
  const api = loadBackground();
  const message = { attachment: [uploadedImage] };
  assert.equal(api.imageAttachment(message).name, uploadedImage.name);
});

test("accepts legacy plural attachment payload too", () => {
  const api = loadBackground();
  const message = { attachments: [uploadedImage] };
  assert.equal(api.imageAttachment(message).name, uploadedImage.name);
});

test("does not treat non-image files as shipment photos", () => {
  const api = loadBackground();
  const file = { contentType: "application/pdf", contentName: "proof.pdf",
    attachmentDataRef: { resourceName: "spaces/test/messages/a/attachments/b" } };
  assert.equal(api.imageAttachment({ attachment: [file] }), null);
});

test("matches the exact waybill, not a longer digit string", () => {
  const api = loadBackground();
  assert.equal(api.containsWaybill({ text: "Shipment " + targetWaybill }, targetWaybill), true);
  assert.equal(api.containsWaybill({ text: "Shipment 1" + targetWaybill }, targetWaybill), false);
});

test("finds an image in a later message that repeats the same waybill", async () => {
  const urls = [];
  const api = loadBackground(async (input) => {
    urls.push(new URL(input));
    return { ok: true, json: async () => ({
      messages: [{ name: "photo-message", createTime: "2026-11-10T01:00:01Z",
        text: "Photo for " + targetWaybill, attachment: [uploadedImage] }]
    }) };
  });
  const result = await api.findFollowingImageInSpace("token", "spaces/test",
    { name: "waybill-message", createTime: "2026-11-10T01:00:00Z" }, targetWaybill);
  assert.equal(result.name, uploadedImage.name);
  assert.equal(urls.length, 1);
  assert.equal(urls[0].searchParams.has("orderBy"), false);
  assert.equal(urls[0].searchParams.get("filter"), 'createTime > "2026-11-10T01:00:00Z"');
  assert.equal(urls[0].searchParams.get("pageSize"), "25");
});

test("stops before a different waybill, even if that message has an image", async () => {
  const api = loadBackground(async () => ({ ok: true, json: async () => ({
    messages: [
      { name: "next-waybill", text: "Shipment 98765432101234", attachment: [uploadedImage] },
      { name: "later-photo", text: "", attachment: [uploadedImage] }
    ]
  }) }));
  const result = await api.findFollowingImageInSpace("token", "spaces/test",
    { name: "waybill-message", createTime: "2026-11-10T01:00:00Z" }, targetWaybill);
  assert.equal(result, null);
});

test("converts downloaded image bytes to a data URL without FileReader", async () => {
  const api = loadBackground();
  const dataUrl = await api.blobToDataUrl(new Blob([new Uint8Array([0, 1, 2, 3])]), "image/jpeg");
  assert.equal(dataUrl, "data:image/jpeg;base64,AAECAw==");
});

test("downloads an uploaded Chat image through the Chat media endpoint", async () => {
  let requestUrl = "";
  const api = loadBackground(async (input) => {
    requestUrl = String(input);
    return { ok: true, blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }) };
  });
  const result = await api.downloadMessageImage("token", uploadedImage);
  assert.ok(requestUrl.startsWith("https://chat.googleapis.com/v1/media/"));
  assert.equal(result, "data:image/jpeg;base64,AQID");
});

test("background no longer sends the rejected ASC orderBy argument", () => {
  assert.equal(source.includes('orderBy: "ASC"'), false);
});


test("runs the complete lookup and returns the downloaded Chat photo", async () => {
  const requests = [];
  const api = loadBackground(async (input, options = {}) => {
    const url = new URL(input);
    requests.push({ url, method: options.method || "GET", body: options.body });

    if (url.pathname === "/v1/spaces") {
      return { ok: true, json: async () => ({ spaces: [{ name: "spaces/ship-pic3", displayName: "SHIP PIC3" }] }) };
    }
    if (url.pathname === "/v1/spaces/-/messages:search") {
      return { ok: true, json: async () => ({ results: [{
        message: { name: "spaces/ship-pic3/messages/waybill-1", createTime: "2026-11-10T01:00:00.123456Z", text: targetWaybill }
      }] }) };
    }
    if (url.pathname === "/v1/spaces/ship-pic3/messages/waybill-1") {
      return { ok: true, json: async () => ({
        name: "spaces/ship-pic3/messages/waybill-1",
        createTime: "2026-11-10T01:00:00.123456Z",
        text: targetWaybill,
        attachment: []
      }) };
    }
    if (url.pathname === "/v1/spaces/ship-pic3/messages") {
      return { ok: true, json: async () => ({ messages: [{
        name: "spaces/ship-pic3/messages/photo-1",
        createTime: "2026-11-10T01:00:01.123456Z",
        text: "",
        attachment: [uploadedImage]
      }] }) };
    }
    if (url.pathname.startsWith("/v1/media/")) {
      return { ok: true, blob: async () => new Blob([new Uint8Array([9, 8, 7])], { type: "image/jpeg" }) };
    }
    throw new Error("Unexpected request: " + url.toString());
  });

  const result = await api.lookupShipmentPhoto(targetWaybill);
  assert.equal(result.waybill, targetWaybill);
  assert.equal(result.imageDataUrl, "data:image/jpeg;base64,CQgH");
  assert.equal(requests.some((r) => r.url.searchParams.has("orderBy")), false);
  assert.ok(requests.some((r) => r.url.pathname === "/v1/spaces/-/messages:search"));
  assert.equal(requests.some((r) => r.url.pathname.endsWith("/messages/waybill-1")), false, "full search result must avoid a redundant message GET");
  assert.ok(requests.some((r) => r.url.pathname === "/v1/media/spaces/ship-pic3/messages/photo/attachments/abc"));
});

test("stops when a message contains the target and a different waybill", async () => {
  const api = loadBackground();
  assert.equal(api.hasDifferentWaybill({ text: targetWaybill + " and 98765432101234" }, targetWaybill), true);
});


test("space lookup uses a cached SHIP PIC3 resource without another API request", async () => {
  let calls = 0;
  const context = {
    chrome: {
      runtime: { onMessage: { addListener() {} }, lastError: null },
      storage: { local: { get: (_keys, callback) => callback({ shippicTargetSpaceName: "spaces/cached-space" }) } }
    },
    URL,
    fetch: async () => { calls++; throw new Error("Should not call API when cache exists"); },
    Blob, Uint8Array, btoa
  };
  vm.createContext(context);
  vm.runInContext(source + `
    globalThis.__cachedSpaceTest = findTargetSpace;
  `, context);
  const cached = await context.__cachedSpaceTest("test-token");
  assert.equal(cached.name, "spaces/cached-space");
  assert.equal(calls, 0);
});


test("collects at most two photos when one Chat message has four image attachments", async () => {
  const api = loadBackground();
  const four = [1,2,3,4].map((n) => ({
    ...uploadedImage,
    name: "attachment-" + n,
    contentName: "shipment-" + n + ".jpg",
    attachmentDataRef: { resourceName: "spaces/ship-pic3/messages/photo/attachments/" + n }
  }));
  const images = api.imageAttachments({ attachment: four });
  assert.equal(images.length, 4);
  assert.equal(images[0].name, "attachment-1");
  assert.equal(images[1].name, "attachment-2");
});

test("collects two photos across adjacent messages and stops at a different waybill", async () => {
  const api = loadBackground(async () => ({ ok: true, json: async () => ({ messages: [
    { name: "photo-one", text: "", attachment: [{ ...uploadedImage, name: "one",
      attachmentDataRef: { resourceName: "spaces/s/messages/m/attachments/one" } }] },
    { name: "photo-two", text: "", attachment: [{ ...uploadedImage, name: "two",
      attachmentDataRef: { resourceName: "spaces/s/messages/m/attachments/two" } }] },
    { name: "next-awb", text: "98765432101234", attachment: [{ ...uploadedImage, name: "three" }] }
  ] }) }));
  const found = await api.findFollowingImagesInSpace("token", "spaces/s",
    { name: "awb", createTime: "2026-11-10T01:00:00Z" }, targetWaybill);
  assert.equal(found.length, 2);
  assert.equal(found[0].name, "one");
  assert.equal(found[1].name, "two");
});

test("keeps the existing singular image helper backward-compatible", () => {
  const api = loadBackground();
  assert.equal(api.imageAttachment({ attachment: [uploadedImage] }).name, uploadedImage.name);
});
