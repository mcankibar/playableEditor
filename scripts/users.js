#!/usr/bin/env node
// Studio accounts. Works next to a running server (same PLAYABLE_DATA folder).
//
//   npm run users -- list
//   npm run users -- add <name>            asks for a password (or --password=...)
//   npm run users -- passwd <name>         new password; signs the user out everywhere
//   npm run users -- remove <name>
//   npm run users -- token <name> [label]  new publish token for `npm run release` (shown once)
//   npm run users -- revoke-tokens <name>

import path from "node:path";
import fs from "node:fs";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { openDb } from "../server/db.js";
import { hashPassword, newToken, tokenHash, validatePassword, validateUsername } from "../server/auth.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = path.resolve(root, process.env.PLAYABLE_DATA || "data");
fs.mkdirSync(dataDir, { recursive: true });
const db = openDb(path.join(dataDir, "studio.db"));

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flag = (name) =>
  process.argv
    .find((a) => a.startsWith(`--${name}=`))
    ?.split("=")
    .slice(1)
    .join("=");
const [command, name, label = ""] = args;

function fail(message) {
  console.error(message);
  process.exit(1);
}

function user(username) {
  if (!username) fail("Username is required");
  return db.findLogin(username)?.user ?? fail(`No user "${username}"`);
}

/** Reads lines without echoing them on a terminal; also works with piped input. */
let rl;
const lines = [];
const waiting = [];
function ask(question) {
  if (!rl) {
    rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    if (process.stdin.isTTY) rl._writeToOutput = () => {}; // typed characters are not echoed
    rl.on("line", (line) => (waiting.length ? waiting.shift()(line) : lines.push(line)));
    rl.on("close", () => waiting.splice(0).forEach((resolve) => resolve("")));
  }
  process.stdout.write(question);
  return new Promise((resolve) => (lines.length ? resolve(lines.shift()) : waiting.push(resolve))).then((line) => {
    if (process.stdin.isTTY) process.stdout.write("\n");
    return line;
  });
}

async function newPassword() {
  const given = flag("password");
  if (given !== undefined) return validatePassword(given);
  const first = await ask("Password: ");
  validatePassword(first);
  if ((await ask("Repeat: ")) !== first) fail("Passwords do not match");
  rl.close();
  return first;
}

try {
  switch (command) {
    case "list": {
      const users = db.listUsers();
      if (!users.length) console.log("No users.");
      for (const u of users) {
        const tokens = db.listApiTokens(u.id);
        console.log(`${u.username.padEnd(20)} since ${u.createdAt.slice(0, 10)}  ${tokens.length} publish token(s)`);
      }
      break;
    }
    case "add": {
      validateUsername(name);
      if (db.findLogin(name)) fail(`User "${name}" already exists`);
      db.createUser(name, hashPassword(await newPassword()));
      console.log(`✓ added ${name}`);
      break;
    }
    case "passwd": {
      const u = user(name);
      db.setPassword(u.id, hashPassword(await newPassword()));
      console.log(`✓ password changed for ${u.username}; existing sessions were signed out`);
      break;
    }
    case "remove": {
      const u = user(name);
      db.deleteUser(u.id);
      console.log(`✓ removed ${u.username}`);
      break;
    }
    case "token": {
      const u = user(name);
      const token = newToken("pst_");
      db.addApiToken(tokenHash(token), u.id, label.slice(0, 80));
      console.log(`Publish token for ${u.username} (only shown now — it can upload releases, nothing else):\n`);
      console.log(`  ${token}\n`);
      console.log(`In the game folder:  PLAYABLE_STUDIO_TOKEN=${token} npm run release`);
      break;
    }
    case "revoke-tokens": {
      const u = user(name);
      console.log(`✓ revoked ${db.deleteApiTokens(u.id)} token(s) of ${u.username}`);
      break;
    }
    default:
      fail(
        "Usage: npm run users -- list | add <name> | passwd <name> | remove <name> | token <name> [label] | revoke-tokens <name>"
      );
  }
} catch (e) {
  fail(e.message);
} finally {
  db.close();
}
