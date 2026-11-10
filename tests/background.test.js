import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { URL } from "node:url";
import { Blob } from "node:buffer";

const source = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");

function loadBackground(fetchImpl = async () => { throw new Error("Unexpected fetch"); }) {
  const context = {
    chrome: { runtime: { onMessage: { addListener() {} }, lastError: null } },
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
      containsWaybill,
      findFollowingImageInSpace,
      blobToDataUrl,
      downloadMessageImage
    };
  `, context);
  return context.__test;
}

const targetWaybill = "14931338241691";
const uploadedImage = {
  name: "spaces/test/messages/photo/attachments/abc",
  contentType: "image/jpeg",
  contentName: "shipment.jpg",
  source: "UPLOADED_CONTENT",
  attachmentDataRef: { resourceName: "spaces/test/messages/photo/attachments/abc" }
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
