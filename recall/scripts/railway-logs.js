#!/usr/bin/env node
/**
 * List Railway services for the linked project and fetch logs.
 * Uses ~/.railway/config.json (project + token). Run from repo root or recall/.
 * Usage: node recall/scripts/railway-logs.js [--lines 200] [--service NAME]
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const CONFIG_PATH = process.env.RAILWAY_CONFIG_PATH || path.join(process.env.HOME || process.env.USERPROFILE, '.railway', 'config.json');

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('Could not read Railway config at', CONFIG_PATH, e.message);
    process.exit(1);
  }
}

function findProjectConfig(config, cwd) {
  const projects = config.projects || {};
  const normalizedCwd = path.normalize(cwd);
  for (const [key, value] of Object.entries(projects)) {
    if (value.projectPath && path.normalize(value.projectPath) === normalizedCwd) return value;
    if (key === normalizedCwd || path.normalize(key) === normalizedCwd) return value;
  }
  return null;
}

async function listServices(projectId, token) {
  const query = `
    query project($id: String!) {
      project(id: $id) {
        name
        services {
          edges {
            node {
              id
              name
            }
          }
        }
      }
    }
  `;
  const res = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify({ query, variables: { id: projectId } }),
  });
  if (!res.ok) {
    throw new Error(`API ${res.status}: ${await res.text()}`);
  }
  const json = await res.json();
  if (json.errors && json.errors.length) {
    throw new Error(json.errors.map((e) => e.message).join('; '));
  }
  const edges = json.data?.project?.services?.edges || [];
  return edges.map((e) => ({ id: e.node.id, name: e.node.name }));
}

async function main() {
  const cwd = process.cwd();
  const config = loadConfig();
  const proj = findProjectConfig(config, cwd);
  if (!proj) {
    console.error('No Railway project linked for current directory:', cwd);
    console.error('Run: railway link (then railway service to link a service)');
    process.exit(1);
  }

  const token = config.user?.token;
  if (!token) {
    console.error('No Railway token in config. Run: railway login');
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const linesIdx = args.indexOf('--lines');
  const lines = linesIdx >= 0 && args[linesIdx + 1] ? args[linesIdx + 1] : '300';
  const serviceIdx = args.indexOf('--service');
  const serviceArg = serviceIdx >= 0 && args[serviceIdx + 1] ? args[serviceIdx + 1] : null;

  let serviceToUse = serviceArg;
  if (!serviceToUse) {
    console.log('Fetching service list from Railway...');
    const services = await listServices(proj.project, token);
    if (services.length === 0) {
      console.error('No services found in this project.');
      process.exit(1);
    }
    console.log('Services in', proj.name || 'project', '(staging):', services.map((s) => s.name).join(', '));
    serviceToUse = services[0].name;
    console.log('Using first service for logs:', serviceToUse);
  }

  console.log('\n--- Railway logs (last', lines, 'lines) ---\n');
  try {
    execSync(`railway logs -n ${lines} --service "${serviceToUse}"`, {
      stdio: 'inherit',
      cwd,
    });
  } catch (e) {
    process.exit(e.status || 1);
  }
}

main();
