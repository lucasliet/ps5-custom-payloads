import fs from "node:fs/promises";
import { buildIconCatalog, latestSnapshot, snapshotManifest, withIconKey } from "./lib.mjs";
import sourcesConfig from "../sources.json" with { type: "json" };

// Read-only refresh of the static catalogs: copies the manifest attached to
// the newest mirror-* snapshot release into payloads_legacy.json (the bare
// array), then rebuilds the default payloads.json icon wrapper from it.
// Run `npm run mirror` to publish a new snapshot first; `npm run icons`
// refreshes the icon data itself.
const token = process.env.GITHUB_TOKEN;
const snapshot = await latestSnapshot(token);
if (!snapshot) {
  throw new Error("no mirror-* snapshot release found; run `npm run mirror` first");
}
const manifest = await snapshotManifest(snapshot, token);
await fs.writeFile("payloads_legacy.json", JSON.stringify(manifest, null, 2) + "\n");

// Keep icon keys from the current default catalog, but only ones icons.json
// still holds - a key that vanished from the icon catalog would make the
// daemon retry a refresh that can never succeed.
const iconKeys = new Set(
  Object.keys(JSON.parse(await fs.readFile("icons.json", "utf8"))?.icons ?? {}),
);
const previousKeys = new Map();
try {
  const previous = JSON.parse(await fs.readFile("payloads.json", "utf8"));
  for (const payload of previous.payloads ?? []) {
    if (payload.name && payload.icon_key && iconKeys.has(payload.icon_key)) {
      previousKeys.set(payload.name, payload.icon_key);
    }
  }
} catch {
  // No catalog or icons yet: the rebuild simply carries no icon keys.
}
const payloads = manifest.map((entry) => withIconKey(entry, previousKeys.get(entry.name)));
await fs.writeFile(
  "payloads.json",
  JSON.stringify(buildIconCatalog(sourcesConfig.name, payloads), null, 2) + "\n",
);
console.log(
  `synced payloads.json and payloads_legacy.json from ${snapshot.tag_name} ` +
    `(${manifest.length} payloads, ${previousKeys.size} icons carried over)`,
);
