#!/usr/bin/env node
// Home agent: run this on the PC at home. It signs in to your cloud project
// with the same email + password as the dashboard and the camera app, then
// drives the real devices (door switch, AC, Govee lights, plugs, Minecraft)
// and runs scenes, automations and phone alerts.
//
//   npm run agent            real devices from server/config.json
//   npm run agent:mock       simulated devices, to try the dashboard
//   npm run agent -- --login sign in again with a different account

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { loadConfig, SERVER_DIR } from './lib/config.js';
import { HomeAgent, AGENT_VERSION } from './lib/agent.js';
import { Cloud, friendlyAuthError } from '../assets/js/cloud.js';
import { CLOUD } from '../assets/js/config.js';

function parseArgs(argv) {
  const out = { mock: false, config: '', login: false, url: '', key: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--mock' || a === '--demo') out.mock = true;
    else if (a === '--login') out.login = true;
    else if (a === '--config' && argv[i + 1]) out.config = argv[++i];
    else if (a === '--url' && argv[i + 1]) out.url = argv[++i];
    else if (a === '--key' && argv[i + 1]) out.key = argv[++i];
    else if (a === '--help' || a === '-h') {
      console.log('Usage: node server/agent.js [--mock] [--login] [--config path/to/config.json] [--url https://xxxx.supabase.co --key ANON_KEY]');
      process.exit(0);
    }
  }
  return out;
}

/** Keeps the signed-in session in a small file so the password is typed once. */
function fileStorage(file) {
  const read = () => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  };
  return {
    getItem: (k) => read()[k] ?? null,
    setItem: (k, v) => {
      const all = read();
      all[k] = v;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(all), { mode: 0o600 });
    },
    removeItem: (k) => {
      const all = read();
      delete all[k];
      fs.writeFileSync(file, JSON.stringify(all), { mode: 0o600 });
    },
  };
}

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Echo stars instead of the password.
      const onKey = () => {
        readline.moveCursor(process.stdout, -rl.line.length - 1, 0);
        process.stdout.write(`${question}${'*'.repeat(rl.line.length)}`);
      };
      process.stdin.on('keypress', onKey);
      rl.question(question, (answer) => {
        process.stdin.off('keypress', onKey);
        rl.close();
        process.stdout.write('\n');
        resolve(answer);
      });
    } else rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

function saveCloudToConfig(file, cloud) {
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    existing = {};
  }
  fs.writeFileSync(file, JSON.stringify({ ...existing, cloud }, null, 2));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.config) process.env.HOME_SERVER_CONFIG = args.config;
  const config = loadConfig(args.mock ? { mock: true, dataDir: path.join(SERVER_DIR, 'data-mock') } : {});
  fs.mkdirSync(config.dataDir, { recursive: true });

  // Which cloud project: --url/--key, then server/config.json "cloud", then the site's baked-in values.
  let cloudCfg = { url: args.url || config.cloud?.url || CLOUD.supabaseUrl || '', anonKey: args.key || config.cloud?.anonKey || CLOUD.supabaseAnonKey || '' };
  if (!cloudCfg.url || !cloudCfg.anonKey) {
    console.log(`Room Guard home agent v${AGENT_VERSION}\nFirst-time setup: paste the Project URL and the anon public key from your Supabase project (Settings → API).`);
    cloudCfg = { url: (await ask('Project URL: ')).trim().replace(/\/$/, ''), anonKey: (await ask('Anon key: ')).trim() };
    if (!cloudCfg.url || !cloudCfg.anonKey) throw new Error('Both values are needed.');
    saveCloudToConfig(config.configFile, cloudCfg);
    console.log(`Saved to ${path.relative(process.cwd(), config.configFile)}.`);
  }

  const { createClient } = await import('@supabase/supabase-js');
  const authFile = path.join(config.dataDir, 'agent-auth.json');
  if (args.login) fs.rmSync(authFile, { force: true });
  const cloud = new Cloud({ url: cloudCfg.url, anonKey: cloudCfg.anonKey, createClient, role: 'agent', storage: fileStorage(authFile) });
  await cloud.init();
  if (!cloud.user) {
    console.log(`Room Guard home agent v${AGENT_VERSION}\nSign in with your home account (the same email + password as the dashboard). It is remembered on this PC.`);
    for (let attempt = 0; attempt < 3 && !cloud.user; attempt++) {
      const email = (await ask('Email: ')).trim();
      const password = await ask('Password: ', { hidden: true });
      try {
        await cloud.signIn(email, password);
      } catch (e) {
        console.log(`  ${friendlyAuthError(e)}`);
      }
    }
    if (!cloud.user) throw new Error('Could not sign in.');
  }

  const agent = new HomeAgent({ cloud, config });
  await agent.start();
  console.log(`Room Guard home agent v${AGENT_VERSION}${config.mock ? ' (MOCK devices)' : ''}`);
  console.log(`  account:  ${cloud.user.email}`);
  console.log(`  project:  ${cloudCfg.url}`);
  console.log(`  devices:  ${config.configFile}`);
  console.log('  Leave this window open. The dashboard shows "agent on" while it runs.');
  const shutdown = () => agent.stop().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e.message || e);
    process.exit(1);
  });
}
