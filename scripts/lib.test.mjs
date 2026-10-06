import assert from "node:assert/strict";
import { test } from "node:test";
import { downloadBytes, snapshotManifest } from "./lib.mjs";

const asset = {
  name: "payloads.json",
  url: "https://api.github.com/repos/owner/private-repo/releases/assets/123",
  browser_download_url: "https://github.com/owner/private-repo/releases/download/mirror-1/payloads.json",
};
const snapshot = { tag_name: "mirror-1", assets: [asset] };

test("snapshot manifest uses the authenticated asset API instead of the private browser URL", async (t) => {
  const manifest = [{ name: "Payload", filename: "payload_v1.elf" }];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, asset.url);
    assert.equal(options.headers.Accept, "application/octet-stream");
    assert.equal(options.headers.Authorization, "Bearer test-token");
    assert.equal(options.redirect, "follow");
    return Response.json(manifest);
  });

  assert.deepEqual(await snapshotManifest(snapshot, "test-token"), manifest);
});

test("asset downloads request binary content and preserve the payload bytes", async (t) => {
  const bytes = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 255]);
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, asset.url);
    assert.equal(options.headers.Accept, "application/octet-stream");
    assert.equal(options.headers.Authorization, "Bearer test-token");
    assert.equal(options.redirect, "follow");
    return new Response(bytes);
  });

  assert.deepEqual(await downloadBytes(asset.url, "test-token"), bytes);
});

test("public asset downloads do not require an authorization header", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    assert.equal(options.headers.Authorization, undefined);
    return new Response("payload");
  });

  assert.equal((await downloadBytes(asset.url)).toString(), "payload");
});

test("snapshot manifest reports a missing manifest asset without downloading", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", async () => {
    throw new Error("unexpected download");
  });

  await assert.rejects(
    snapshotManifest({ tag_name: "mirror-1", assets: [] }, "test-token"),
    /mirror-1: snapshot has no payloads.json asset/,
  );
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("snapshot manifest rejects non-array JSON", async (t) => {
  t.mock.method(globalThis, "fetch", async () => Response.json({ message: "metadata" }));

  await assert.rejects(snapshotManifest(snapshot, "test-token"), /mirror-1: manifest is not an array/);
});

test("asset download failures remain fatal and include the HTTP status", async (t) => {
  t.mock.method(globalThis, "fetch", async () => new Response("Not Found", { status: 404 }));

  await assert.rejects(downloadBytes(asset.url, "test-token"), /download returned 404/);
  await assert.rejects(snapshotManifest(snapshot, "test-token"), /download returned 404/);
});
