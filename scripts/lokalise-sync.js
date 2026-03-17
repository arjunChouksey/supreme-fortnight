#!/usr/bin/env node
/**
 * lokalise-sync.js
 *
 * Commands:
 *   sync  --pr-name <name>   Push keys, poll every hour, download when translations are done
 *   push  --pr-name <name>   Push new/updated source keys only
 *   check --pr-name <name>   One-shot translation status check (exit 0 = done, exit 1 = pending)
 *
 * Key convention:
 *   Nested JSON paths use '::' as separator in Lokalise
 *   e.g. { nested: { key: "val" } }  →  "nested::key"
 */

const https = require("https");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const API_TOKEN = "bee71333209eda1043c92430f86a5fd9e2524750";
const PROJECT_ID = "4166601769b80f1cb7c410.02221382";
const BASE_LANG = "en";
const LOCALE_DIR = path.resolve("./locale/en");
const POLL_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MAX_POLL_ATTEMPTS = 6; // 6 hours max

const [, , command, ...rawArgs] = process.argv;

function getArg(name) {
  const idx = rawArgs.indexOf(name);
  return idx !== -1 ? rawArgs[idx + 1] : null;
}

const PR_NAME = getArg("--pr-name");

// ── HTTP helper ───────────────────────────────────────────────────────────────

function apiRequest(method, endpoint, body = null) {
  return new Promise((resolve, reject) => {
    const bodyStr = body ? JSON.stringify(body) : null;
    const options = {
      hostname: "api.lokalise.com",
      path: `/api2${endpoint}`,
      method,
      headers: {
        "X-Api-Token": API_TOKEN,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(bodyStr ? { "Content-Length": Buffer.byteLength(bodyStr) } : {}),
      },
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(data);
          if (res.statusCode >= 400) {
            reject(
              new Error(`API ${res.statusCode}: ${JSON.stringify(parsed)}`),
            );
          } else {
            resolve(parsed);
          }
        } catch {
          reject(new Error(`Failed to parse response: ${data}`));
        }
      });
    });

    req.on("error", reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith("https") ? https : http;
    const file = fs.createWriteStream(dest);

    protocol
      .get(url, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          file.close();
          fs.unlinkSync(dest);
          return downloadFile(res.headers.location, dest)
            .then(resolve)
            .catch(reject);
        }
        res.pipe(file);
        file.on("finish", () => {
          file.close();
          resolve();
        });
      })
      .on("error", (err) => {
        fs.unlinkSync(dest);
        reject(err);
      });
  });
}

// ── Key transformer: nested JSON → flat keys with '::' separator ──────────────

function flattenJSON(obj, prefix = "") {
  return Object.entries(obj).reduce((acc, [k, v]) => {
    const key = prefix ? `${prefix}::${k}` : k;
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      Object.assign(acc, flattenJSON(v, key));
    } else {
      acc[key] = String(v);
    }
    return acc;
  }, {});
}

// ── Get added/updated keys from git diff ──────────────────────────────────────

function getChangedKeys(baseRef) {
  const files = fs.readdirSync(LOCALE_DIR).filter((f) => f.endsWith(".json"));

  const added = {};
  const updated = {};

  for (const fileName of files) {
    const gitPath = `locale/en/${fileName}`;

    let oldFlat = {};
    try {
      const oldJson = execSync(`git show ${baseRef}:${gitPath}`, {
        encoding: "utf8",
      });
      oldFlat = flattenJSON(JSON.parse(oldJson));
    } catch {
      // File is new on this branch — all its keys are added
    }

    const newFlat = flattenJSON(
      JSON.parse(fs.readFileSync(path.join(LOCALE_DIR, fileName), "utf8")),
    );

    for (const [key, translation] of Object.entries(newFlat)) {
      if (!(key in oldFlat)) {
        added[key] = { translation, fileName };
      } else if (oldFlat[key] !== translation) {
        updated[key] = { translation, fileName };
      }
    }
  }

  return { added, updated };
}

// ── List all keys with pagination ─────────────────────────────────────────────

async function listAllKeys(params = {}) {
  const allKeys = [];
  let page = 1;

  while (true) {
    const query = new URLSearchParams({
      limit: 500,
      page,
      ...params,
    }).toString();
    const res = await apiRequest(
      "GET",
      `/projects/${PROJECT_ID}/keys?${query}`,
    );
    if (!res.keys || res.keys.length === 0) break;
    allKeys.push(...res.keys);
    if (res.keys.length < 500) break;
    page++;
  }

  return allKeys;
}

// ── PUSH ──────────────────────────────────────────────────────────────────────

async function push() {
  if (!PR_NAME) throw new Error("--pr-name is required");

  const baseRef = getArg("--base-ref") || "origin/main";
  const { added, updated } = getChangedKeys(baseRef);

  const addedCount = Object.keys(added).length;
  const updatedCount = Object.keys(updated).length;

  console.log(`Git diff: ${addedCount} added, ${updatedCount} updated`);

  if (addedCount === 0 && updatedCount === 0) {
    console.log("No key changes in git diff — nothing pushed.");
    return false;
  }

  // For updated keys we need the Lokalise key_id — fetch only those
  const toCreate = Object.entries(added).map(
    ([keyName, { translation, fileName }]) => ({
      key_name: keyName,
      platforms: ["web"],
      filenames: { web: fileName },
      tags: [PR_NAME],
      translations: { [BASE_LANG]: { translation } },
    }),
  );

  const toUpdate = [];

  if (updatedCount > 0) {
    const existing = await listAllKeys({
      filter_keys: Object.keys(updated).join(","),
    });
    const existingByName = new Map(existing.map((k) => [k.key_name, k]));

    for (const [keyName, { translation, fileName }] of Object.entries(
      updated,
    )) {
      const found = existingByName.get(keyName);
      if (found) {
        toUpdate.push({
          key_id: found.key_id,
          filenames: { web: fileName },
          tags: [...new Set([...(found.tags || []), PR_NAME])],
          translations: { [BASE_LANG]: { translation } },
        });
      } else {
        // Not in Lokalise yet — create instead
        toCreate.push({
          key_name: keyName,
          platforms: ["web"],
          filenames: { web: fileName },
          tags: [PR_NAME],
          translations: { [BASE_LANG]: { translation } },
        });
      }
    }
  }

  console.dir(
    {
      added,
      updated,
      toCreate,
      toUpdate,
    },
    { depth: null },
  );

  return false;

  for (let i = 0; i < toCreate.length; i += 500) {
    const res = await apiRequest("POST", `/projects/${PROJECT_ID}/keys`, {
      keys: toCreate.slice(i, i + 500),
    });
    if (res.errors?.length) console.error("Create errors:", res.errors);
    else console.log(`Created ${res.keys?.length} key(s)`);
  }

  for (let i = 0; i < toUpdate.length; i += 10) {
    await Promise.all(
      toUpdate
        .slice(i, i + 10)
        .map(({ key_id, ...payload }) =>
          apiRequest(
            "PUT",
            `/projects/${PROJECT_ID}/keys/${key_id}`,
            payload,
          ).catch((err) =>
            console.error(`Update error for key ${key_id}:`, err.message),
          ),
        ),
    );
  }

  console.log(
    `Push complete. Created: ${toCreate.length} | Updated: ${toUpdate.length}`,
  );
  return true;
}

// ── CHECK (returns boolean, no process.exit) ──────────────────────────────────

async function isTranslationComplete() {
  const keys = await listAllKeys({
    filter_tags: PR_NAME,
    include_translations: 1,
  });

  if (keys.length === 0) {
    console.log("No keys found for this PR tag.");
    return false;
  }

  console.log(`Found ${keys.length} key(s) tagged "${PR_NAME}"`);

  const pending = keys.filter((key) => {
    const nonBase = (key.translations || []).filter(
      (t) => t.language_iso !== BASE_LANG,
    );
    if (nonBase.length === 0) return true;
    return !nonBase.every(
      (t) => t.is_reviewed === true && t.is_unverified === false,
    );
  });

  if (pending.length > 0) {
    console.log(`${pending.length} key(s) still pending:`);
    pending.forEach((k) => {
      const notDone = (k.translations || [])
        .filter(
          (t) =>
            t.language_iso !== BASE_LANG && (!t.is_reviewed || t.is_unverified),
        )
        .map((t) => t.language_iso);
      const label = notDone.length
        ? `[${notDone.join(", ")}]`
        : "[no translations yet]";
      console.log(`  - ${k.key_name}: ${label}`);
    });
    return false;
  }

  console.log("All translations reviewed and verified.");
  return true;
}

// ── DOWNLOAD ──────────────────────────────────────────────────────────────────

async function downloadTranslations() {
  console.log("Requesting translation bundle from Lokalise...");

  const res = await apiRequest(
    "POST",
    `/projects/${PROJECT_ID}/files/download`,
    {
      format: "json",
      original_filenames: true,
    },
  );

  const bundleUrl = res.bundle_url;
  if (!bundleUrl) throw new Error("No bundle_url in download response");

  const zipPath = "/tmp/lokalise-bundle.zip";
  await downloadFile(bundleUrl, zipPath);
  execSync(`unzip -o ${zipPath} -d .`);
  fs.unlinkSync(zipPath);

  console.log("Translations downloaded and extracted.");
}

// ── SYNC (push → poll → download) ────────────────────────────────────────────

async function sync() {
  if (!PR_NAME) throw new Error("--pr-name is required");

  const hasChanges = await push();
  if (!hasChanges) {
    console.log("Nothing to sync — exiting early.");
    return;
  }

  for (let attempt = 1; attempt <= MAX_POLL_ATTEMPTS; attempt++) {
    console.log(
      `\nChecking translation status (attempt ${attempt}/${MAX_POLL_ATTEMPTS})...`,
    );

    const done = await isTranslationComplete();
    if (done) {
      await downloadTranslations();
      return;
    }

    if (attempt < MAX_POLL_ATTEMPTS) {
      console.log(`Not ready. Waiting 1 hour before next check...`);
      await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
  }

  throw new Error(
    `Timed out after ${MAX_POLL_ATTEMPTS} hours waiting for translations.`,
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  switch (command) {
    case "sync":
      return sync();
    case "push":
      return push();
    case "check": {
      if (!PR_NAME) throw new Error("--pr-name is required");
      const done = await isTranslationComplete();
      process.exit(done ? 0 : 1);
    }
    default:
      console.error(
        "Usage: node scripts/lokalise-sync.js <sync|push|check> --pr-name <name>",
      );
      process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
