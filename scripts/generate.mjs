import fs from "node:fs/promises";
import { latestSnapshot, snapshotManifest } from "./lib.mjs";

// Read-only refresh of the static catalog: copies the manifest attached to
// the newest mirror-* snapshot release into payloads.json. Run
// `npm run mirror` to publish a new snapshot first.
const token = process.env.GITHUB_TOKEN;
const snapshot = await latestSnapshot(token);
if (!snapshot) {
  throw new Error("no mirror-* snapshot release found; run `npm run mirror` first");
}
const manifest = await snapshotManifest(snapshot, token);
await fs.writeFile("payloads.json", JSON.stringify(manifest, null, 2) + "\n");
console.log(`synced payloads.json from ${snapshot.tag_name} (${manifest.length} payloads)`);
