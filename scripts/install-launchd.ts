import 'dotenv/config';
import { execFileSync, execSync } from 'child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from 'fs';
import { homedir, userInfo } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isOwnedOn, launchdLabelPrefix, moduleFor, type SelectionInput } from '../src/modules.js';

/**
 * Installs the background services (launchd agents) for the modules that are on.
 *
 *   npm run install:service             render + (re)load plists for enabled modules,
 *                                       and unload ones whose module is now off
 *   npm run install:service -- --dry    print what would happen, touch nothing
 *   npm run uninstall:service           unload and remove every plist this installs
 *   npm run restart                     restart the main agent
 *   npm run pause / npm run resume      stop / restore background features
 *
 * Templates live in launchd/templates/<name>.plist.tmpl. Tokens: {{NODE}},
 * {{REPO}}, {{HOME}}, {{LABEL_PREFIX}}, {{PATH}}. Each template belongs to the
 * module that lists it under `launchd` in src/modules.ts.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TEMPLATE_DIR = join(ROOT, 'launchd', 'templates');

export interface InstallVars {
  NODE: string;
  REPO: string;
  HOME: string;
  LABEL_PREFIX: string;
  PATH: string;
}

export interface PlannedService {
  name: string;
  label: string;
  module: string | undefined;
  enabled: boolean;
  plistPath: string;
  rendered: string;
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function renderTemplate(template: string, vars: InstallVars): string {
  return template.replace(/\{\{(NODE|REPO|HOME|LABEL_PREFIX|PATH)\}\}/g, (_, key: keyof InstallVars) => xmlEscape(vars[key]));
}

export function brewPrefix(): string {
  return existsSync('/opt/homebrew/bin') ? '/opt/homebrew' : '/usr/local';
}

/**
 * The node binary launchd should run. Resolves symlinks (so nvm/fnm shims point
 * at a real binary), except that a Homebrew Cellar path is versioned and breaks
 * on the next `brew upgrade`, so the stable <prefix>/bin/node is used instead.
 */
export function resolveNode(prefix = brewPrefix()): string {
  let found = '';
  try {
    found = execSync('command -v node', { shell: '/bin/sh', encoding: 'utf8' }).trim();
  } catch {
    found = '';
  }
  if (!found) found = process.execPath;
  const real = realpathSync(found);
  if (real.includes('/Cellar/') && existsSync(join(prefix, 'bin', 'node'))) return join(prefix, 'bin', 'node');
  return real;
}

export function defaultVars(env: NodeJS.ProcessEnv = process.env, repo = process.cwd()): InstallVars {
  const prefix = brewPrefix();
  const node = resolveNode(prefix);
  const pathParts = [dirname(node), `${prefix}/bin`, `${prefix}/sbin`, '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  return {
    NODE: node,
    REPO: repo,
    HOME: homedir(),
    LABEL_PREFIX: launchdLabelPrefix(env),
    PATH: [...new Set(pathParts)].join(':'),
  };
}

export function templateNames(dir = TEMPLATE_DIR): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.plist.tmpl')).map((f) => f.replace(/\.plist\.tmpl$/, '')).sort();
}

export function planServices(vars: InstallVars, selection: SelectionInput = {}, agentsDir = join(homedir(), 'Library', 'LaunchAgents')): PlannedService[] {
  return templateNames().map((name) => {
    const label = `${vars.LABEL_PREFIX}.${name}`;
    const owner = moduleFor('launchd', name, selection.modules);
    return {
      name,
      label,
      module: owner,
      // A template no module claims is never installed.
      enabled: owner ? isOwnedOn('launchd', name, selection) : false,
      plistPath: join(agentsDir, `${label}.plist`),
      rendered: renderTemplate(readFileSync(join(TEMPLATE_DIR, `${name}.plist.tmpl`), 'utf8'), vars),
    };
  });
}

const domain = () => `gui/${userInfo().uid}`;

function launchctl(args: string[], dry: boolean, quiet = false): boolean {
  if (dry) { console.log(`  would run: launchctl ${args.join(' ')}`); return true; }
  try {
    execFileSync('/bin/launchctl', args, { stdio: quiet ? 'ignore' : 'inherit' });
    return true;
  } catch {
    return false;
  }
}

function unload(svc: PlannedService, dry: boolean, remove: boolean): void {
  launchctl(['bootout', `${domain()}/${svc.label}`], dry, true);
  if (remove && existsSync(svc.plistPath)) {
    if (dry) console.log(`  would remove ${svc.plistPath}`);
    else unlinkSync(svc.plistPath);
  }
}

function install(dry: boolean): void {
  const vars = defaultVars();
  if (!existsSync(join(vars.REPO, 'package.json')) || !existsSync(join(vars.REPO, 'launchd', 'templates'))) {
    console.error('Run this from the assistant folder (the one with package.json).');
    process.exit(1);
  }
  if (!existsSync(join(vars.REPO, 'dist', 'index.js'))) {
    console.warn('Note: dist/index.js is missing, so the main agent will not start until you run npm run build.');
  }
  console.log(`node: ${vars.NODE}\nrepo: ${vars.REPO}\nlabels: ${vars.LABEL_PREFIX}.*${dry ? '\n(dry run: nothing is written or loaded)' : ''}\n`);
  if (!dry) mkdirSync(join(vars.REPO, 'logs'), { recursive: true });
  if (!dry) mkdirSync(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true });

  for (const svc of planServices(vars)) {
    if (!svc.enabled) {
      if (existsSync(svc.plistPath)) {
        console.log(`- ${svc.label}: module "${svc.module}" is off, removing`);
        unload(svc, dry, true);
      } else {
        console.log(`- ${svc.label}: skipped (module "${svc.module ?? 'none'}" is off)`);
      }
      continue;
    }
    console.log(`+ ${svc.label} (module "${svc.module}")`);
    if (dry) {
      console.log(`  would write ${svc.plistPath}`);
    } else {
      writeFileSync(svc.plistPath, svc.rendered);
    }
    unload(svc, dry, false);
    if (!launchctl(['bootstrap', domain(), svc.plistPath], dry)) {
      console.error(`  could not load ${svc.label}; check the plist with: plutil -lint "${svc.plistPath}"`);
    }
  }
  if (!dry) console.log('\nDone. Check readiness with: npm run doctor -- --setup');
}

function uninstall(dry: boolean): void {
  const vars = defaultVars();
  for (const svc of planServices(vars)) {
    if (!existsSync(svc.plistPath)) continue;
    console.log(`- ${svc.label}`);
    unload(svc, dry, true);
  }
}

/** Restart the agent (and with --all every installed KeepAlive service). */
function restart(all: boolean, dry: boolean): void {
  const vars = defaultVars();
  const names = all ? planServices(vars).filter((s) => s.name !== 'chrome' && existsSync(s.plistPath) && /KeepAlive/.test(s.rendered)).map((s) => s.name) : ['agent'];
  for (const name of names) {
    const label = `${vars.LABEL_PREFIX}.${name}`;
    if (!launchctl(['kickstart', '-k', `${domain()}/${label}`], dry)) {
      console.error(`${label} is not loaded; run npm run install:service first.`);
    }
  }
}

function setPaused(paused: boolean, dry: boolean): void {
  const sentinel = join(process.cwd(), 'AUTOMATIONS_OFF');
  if (paused) {
    if (!dry) writeFileSync(sentinel, `paused ${new Date().toISOString()}\n`);
    console.log('Paused: background features (check-ins, nudges, background reading) stop; replies still work.');
  } else {
    if (!dry && existsSync(sentinel)) unlinkSync(sentinel);
    console.log('Resumed: background features are back on for the modules you enabled.');
  }
  restart(true, dry);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1]);
if (isMain) {
  const args = new Set(process.argv.slice(2));
  const dry = args.has('--dry');
  if (args.has('--uninstall')) uninstall(dry);
  else if (args.has('--restart')) restart(args.has('--all'), dry);
  else if (args.has('--pause')) setPaused(true, dry);
  else if (args.has('--resume')) setPaused(false, dry);
  else install(dry);
}
