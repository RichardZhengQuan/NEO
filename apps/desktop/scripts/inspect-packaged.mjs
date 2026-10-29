// Artifact-only structural inspector. Does not execute app code or certify runtime.
import path from 'node:path';
import { lstat, realpath, readlink, readdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
const posix = path.posix;
class InspectorUnsupported extends Error {
  constructor(message) {
    super(message);
    this.name = 'InspectorUnsupported';
  }
}
const fail = message => {
  throw new Error(message);
};
const contained = (root, target) => target === root || target.startsWith(root + path.sep);
const clean = value => {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || posix.isAbsolute(value)) fail('Invalid archive/virtual path: ' + String(value));
  const normalized = posix.normalize(value);
  if (normalized === '..' || normalized.startsWith('../')) fail('Escaping archive/virtual path: ' + value);
  return normalized === '.' ? '' : normalized;
};
const sha = b => createHash('sha256').update(b).digest('hex');
export async function auditPhysicalBundle(appBundle) {
  const root = path.resolve(appBundle),
    rootStat = await lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('App root must be a real directory');
  const actualRoot = await realpath(root),
    resources = path.join(actualRoot, 'Contents/Resources');
  const entries = [];
  async function walk(dir) {
    for (const name of (await readdir(dir)).sort()) {
      const item = path.join(dir, name),
        stat = await lstat(item),
        relative = path.relative(actualRoot, item);
      if (stat.isSymbolicLink()) {
        let target;
        try {
          target = await realpath(item);
        } catch {
          fail('Broken/cyclic physical symlink: ' + relative);
        }
        if (!contained(actualRoot, target)) fail('Physical symlink escapes app: ' + relative);
        if (contained(resources, item) && !contained(resources, target)) fail('Physical symlink escapes Resources: ' + relative);
        entries.push({
          path: relative,
          kind: 'symlink',
          link: await readlink(item),
          resolved: target
        });
      } else if (stat.isDirectory()) await walk(item);else if (stat.isFile()) entries.push({
        path: relative,
        kind: 'file',
        size: stat.size,
        sha256: sha(await readFile(item))
      });else fail('Unsupported physical special file: ' + relative);
    }
  }
  await walk(actualRoot);
  return {
    root: actualRoot,
    resources,
    entries
  };
}
// Link targets in the actual @electron/asar header are archive-root-relative.
// Validate raw metadata BEFORE allowing official extractFile to follow a link.
export function validateArchiveHeader(header, {
  payloadSize
} = {}) {
  if (payloadSize !== undefined && (!Number.isSafeInteger(payloadSize) || payloadSize < 0)) fail('Invalid archive payload size');
  if (!header?.files || typeof header.files !== 'object' || Array.isArray(header.files)) fail('Archive root must be a directory');
  const entries = new Map();
  function visit(node, prefix = '', parentUnpacked = false) {
    if (!node || typeof node !== 'object' || Array.isArray(node)) fail('Invalid archive metadata');
    if (node.unpacked !== undefined && typeof node.unpacked !== 'boolean') fail('Invalid archive unpacked flag: ' + prefix);
    const unpacked = parentUnpacked || node.unpacked === true;
    if (node.files !== undefined) {
      if (typeof node.files !== 'object' || Array.isArray(node.files)) fail('Invalid archive directory');
      if (node.link !== undefined || node.size !== undefined || node.offset !== undefined) fail('Archive entry mixes directory/link/file: ' + prefix);
      entries.set(prefix, {
        ...node,
        unpacked: parentUnpacked || node.unpacked === true
      });
      for (const [name, child] of Object.entries(node.files)) {
        if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) fail('Invalid archive entry name: ' + name);
        visit(child, prefix ? prefix + '/' + name : name, parentUnpacked || node.unpacked === true);
      }
    } else {
      if (node.link !== undefined) {
        if (node.size !== undefined || node.offset !== undefined) fail('Archive entry mixes link/file: ' + prefix);
      } else {
        if (!Number.isSafeInteger(node.size) || node.size < 0) fail('Invalid archive file metadata: ' + prefix);
        if (!unpacked) {
          if (typeof node.offset !== 'string' || !/^(0|[1-9][0-9]*)$/.test(node.offset)) fail('Invalid packed archive offset: ' + prefix);
          const offset = Number(node.offset);
          if (!Number.isSafeInteger(offset)) fail('Invalid packed archive offset: ' + prefix);
          // Subtraction prevents an overflowing offset + size from passing.
          if (payloadSize !== undefined && (offset > payloadSize || node.size > payloadSize - offset)) fail('Packed archive file exceeds payload: ' + prefix);
        }
      }
      entries.set(prefix, {
        ...node,
        unpacked: parentUnpacked || node.unpacked === true
      });
    }
  }
  visit(header);
  function resolve(input, seen = new Set()) {
    const p = clean(input);
    if (seen.has(p) || seen.size > 40) fail('Archive symlink cycle: ' + p);
    seen.add(p);
    const components = p ? p.split('/') : [];
    for (let i = 0; i < components.length; i++) {
      const ancestor = components.slice(0, i + 1).join('/'),
        node = entries.get(ancestor);
      if (!node) fail('Missing archive link/file target: ' + ancestor);
      if (node.link !== undefined) {
        const target = clean(node.link);
        if (!target) fail('Archive link targets root: ' + ancestor);
        return resolve(posix.join(target, ...components.slice(i + 1)), seen);
      }
    }
    const node = entries.get(p);
    if (!node) fail('Missing archive target: ' + p);
    return {
      path: p,
      node
    };
  }
  for (const [p, node] of entries) if (node.link !== undefined) resolve(p);
  return {
    entries,
    resolve
  };
}
export async function validateUnpacked(archive, resources) {
  const unpackRoot = path.join(resources, 'app.asar.unpacked'),
    checked = [];
  for (const [name, node] of archive.entries) {
    if (!node.unpacked || node.files || node.link !== undefined) continue;
    const physical = path.join(unpackRoot, ...name.split('/'));
    let actual;
    try {
      actual = await realpath(physical);
    } catch {
      fail('Missing unpacked runtime file: ' + name);
    }
    if (!contained(unpackRoot, actual)) fail('Unpacked file escapes matching archive sibling: ' + name);
    const stat = await lstat(actual);
    if (!stat.isFile()) fail('Unpacked entry is not a file: ' + name);
    if (typeof node.size === 'number' && stat.size !== node.size) fail('Unpacked file size mismatch: ' + name);
    checked.push(name);
  }
  return checked;
}
// Node22 resolvePackageTarget semantics: arrays fall back only on invalid
// targets, null, or inactive conditions. Missing selected files DO NOT fall back.
function activeExportTargets(value, conditions, subpath = '.', result = [], skipped = []) {
  const invalid = message => Object.assign(new Error(message), {
    code: 'ERR_INVALID_PACKAGE_TARGET'
  });
  function select(target) {
    if (target === null) return null;
    if (typeof target === 'string') {
      const segments = target.slice(2).split('/');
      if (!target.startsWith('./') || target.includes('\\') || segments.some(s => s === '..' || s === '.' || s.toLowerCase() === 'node_modules') || /%2f|%5c/i.test(target)) throw invalid('Invalid export array target ' + target);
      return target;
    }
    if (Array.isArray(target)) {
      if (target.length === 0) return null;
      let last;
      for (const item of target) {
        try {
          const selected = select(item);
          if (selected === undefined) continue;
          if (selected === null) {
            last = null;
            continue;
          }
          return selected;
        } catch (error) {
          if (error.code !== 'ERR_INVALID_PACKAGE_TARGET') throw error;
          last = error;
        }
      }
      if (last instanceof Error) throw last;
      return last;
    }
    if (target && typeof target === 'object') {
      for (const key of Object.keys(target)) if (/^(0|[1-9][0-9]*)$/.test(key)) fail('Invalid numeric export condition');
      for (const [key, branch] of Object.entries(target)) if (key === 'default' || conditions.has(key)) {
        const selected = select(branch);
        if (selected !== undefined) return selected;
      }
      return undefined;
    }
    throw invalid('Invalid export target type');
  }
  if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).some(key => key.startsWith('.'))) {
    if (!Object.keys(value).every(key => key.startsWith('.'))) fail('Mixed exports subpath/condition keys');
    for (const [key, target] of Object.entries(value)) {
      // Node 22 and Electron 44's Node 24 exclude exact subpaths ending in '/'.
      // This tests the KEY, not the target: a reachable export to a directory
      // still fails the file check. Pattern keys retain their normal validation.
      if (!key.includes('*') && key.endsWith('/')) {
        skipped.push(key);
        continue;
      }
      const selected = select(target);
      if (typeof selected === 'string') result.push({
        subpath: key,
        target: selected
      });
    }
  } else {
    const selected = select(value);
    if (typeof selected === 'string') result.push({
      subpath,
      target: selected
    });
  }
  return result;
}
// fs is a contained resources-relative VFS. It never falls back to host/global
// node_modules. A missing dependency therefore cannot be filled by the checkout.
export async function auditRuntimeDependencies(fs, {
  root = 'app.asar',
  platform = 'darwin',
  arch = 'arm64'
} = {}) {
  const records = [],
    edges = [],
    limits = [],
    visited = new Set();
  const exists = async p => fs.kind(clean(p)).then(kind => kind === 'file');
  const compatible = manifest => [['os', platform], ['cpu', arch]].every(([field, value]) => {
    const specs = manifest[field];
    return !Array.isArray(specs) || !specs.includes('!' + value) && (!specs.some(s => !s.startsWith('!')) || specs.includes(value));
  });
  async function packageAt(dir) {
    const file = posix.join(dir, 'package.json');
    if (!(await exists(file))) return null;
    try {
      return JSON.parse(await fs.read(file));
    } catch (error) {
      fail('Invalid packaged manifest ' + file + ': ' + error.message);
    }
  }
  async function findPackage(from, name) {
    if (!/^(@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+$/.test(name)) fail('Invalid package name ' + name);
    let cursor = from;
    while (true) {
      if (posix.basename(cursor) !== 'node_modules') {
        const candidate = posix.join(cursor, 'node_modules', name);
        if (await packageAt(candidate)) return fs.realpath ? fs.realpath(candidate) : candidate;
      }
      if (!cursor) break;
      cursor = posix.dirname(cursor);
      if (cursor === '.') cursor = '';
    }
    return null;
  }
  async function validateEntries(dir, manifest) {
    const targets = [];
    if (manifest.exports !== undefined) {
      const skipped = [];
      for (const mode of ['import', 'require']) for (const item of activeExportTargets(manifest.exports, new Set(['node', mode]), '.', [], skipped)) targets.push({
        ...item,
        mode
      });
      for (const subpath of new Set(skipped)) limits.push({
        package: dir,
        subpath,
        reason: 'Legacy non-pattern export key ending in / is unreachable in Node 22/24; not a required file target'
      });
      if (!targets.length) limits.push({
        package: dir,
        reason: 'No active node export; subpath usage needs runtime validation'
      });
    } else targets.push({
      subpath: '.',
      target: manifest.main ?? 'index.js',
      mode: 'legacy'
    });
    const unique = new Set();
    for (const item of targets) {
      const key = item.target;
      if (unique.has(key)) continue;
      unique.add(key);
      if (typeof key !== 'string' || posix.isAbsolute(key) || key.includes('\\') || key.includes('\0')) fail('Invalid entry target ' + dir + ': ' + key);
      if (manifest.exports !== undefined && (!key.startsWith('./') || key.split('/').includes('node_modules') || /%2f|%5c/i.test(key))) fail('Invalid export target ' + dir + ': ' + key);
      const relative = clean(key),
        target = clean(posix.join(dir, relative));
      if (target !== dir && !target.startsWith(dir + '/')) fail('Entry target escapes package ' + dir + ': ' + key);
      if (key.includes('*')) {
        const expression = new RegExp('^' + target.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*') + '$');
        const matches = (await fs.list()).filter(name => expression.test(name));
        let matched = false;
        for (const name of matches) if (await exists(name)) {
          matched = true;
          break;
        }
        if (!matched) fail('Missing wildcard export files ' + dir + ': ' + key);
        limits.push({
          package: dir,
          reason: 'Wildcard exports checked for nonempty file expansion; individual runtime subpaths not proven'
        });
      } else {
        const candidates = manifest.exports !== undefined ? [target] : [target, target + '.js', target + '.json', target + '.node', posix.join(target, 'index.js'), posix.join(dir, 'index.js')];
        let found = false;
        for (const candidate of candidates) if (await exists(candidate)) {
          found = true;
          break;
        }
        if (!found) fail('Missing runtime entry/export ' + dir + ': ' + key);
      }
    }
    return targets;
  }
  async function visit(dir, chain = []) {
    dir = fs.realpath ? await fs.realpath(dir) : dir;
    if (visited.has(dir)) return;
    visited.add(dir);
    const manifest = await packageAt(dir);
    if (!manifest) fail('Missing packaged manifest ' + dir);
    for (const [field, value] of [['os', platform], ['cpu', arch]]) if (Array.isArray(manifest[field])) {
      const specs = manifest[field];
      if (specs.includes('!' + value) || specs.some(s => !s.startsWith('!')) && !specs.includes(value)) fail('Runtime package incompatible with ' + field + ': ' + dir);
    }
    const targets = await validateEntries(dir, manifest);
    records.push({
      path: dir,
      name: manifest.name ?? null,
      version: manifest.version ?? null,
      manifestSha256: sha(await fs.read(posix.join(dir, 'package.json'))),
      targets
    });
    const optional = manifest.optionalDependencies ?? {},
      required = {
        ...(manifest.dependencies ?? {})
      };
    for (const name of Object.keys(optional)) delete required[name];
    const peer = manifest.peerDependencies ?? {};
    for (const name of Object.keys(peer)) if (!manifest.peerDependenciesMeta?.[name]?.optional) required[name] = peer[name];
    for (const [name, isOptional] of [...Object.keys(required).map(name => [name, false]), ...Object.keys(optional).map(name => [name, true])]) {
      const resolved = await findPackage(dir, name);
      if (!resolved) {
        if (isOptional) {
          limits.push({
            package: dir,
            dependency: name,
            reason: 'Optional dependency absent; runtime requirement not proven'
          });
          continue;
        }
        fail('Missing transitive runtime dependency: ' + [...chain, manifest.name ?? dir, name].join(' -> '));
      }
      if (isOptional && !compatible(await packageAt(resolved))) {
        limits.push({
          package: dir,
          dependency: name,
          reason: 'Optional package explicitly excluded for target os/cpu; not runtime-verified'
        });
        continue;
      }
      edges.push({
        from: dir,
        name,
        to: resolved,
        optional: isOptional
      });
      await visit(resolved, [...chain, manifest.name ?? dir]);
    }
  }
  await visit(clean(root));
  return {
    status: 'STRUCTURAL_DEPENDENCY_CHECKS_PASS',
    records,
    edges,
    limits,
    runtimeProven: false,
    limitations: ['Declared dependencies and active entry/export files checked; not a JavaScript import-graph or native-addon ABI check.', 'Dynamic imports/requires, export conditions beyond node/import/require/default, and optional dependency behavior require actual packaged smoke.']
  };
}
// Vite emits ordinary HTML entry tags. Parse that bounded subset without
// executing HTML; unsupported constructs fail instead of guessing browser URLs.
function webEntryReferences(html) {
  if (html.length > 2 * 1024 * 1024) fail('Bundled web index exceeds inspection bound');
  const references = [];
  const whitespace = /[ \t\n\f\r]/;
  const trimUrl = value => value.replace(/^[ \t\n\f\r]+|[ \t\n\f\r]+$/g, '');
  const unsupported = message => { throw new InspectorUnsupported(message); };
  const decode = value => {
    const entities = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
    const pattern = /&#(x[0-9a-f]+|[0-9]+);?|&([a-z][a-z0-9]*);|&(amp|quot|lt|gt)(?![a-z0-9=])/gi;
    // Legacy named references without a semicolon are deliberately unsupported
    // outside this subset. Never certify a literal filename the browser decodes.
    const residue = value.replace(pattern, '').split(/[?#]/, 1)[0];
    if (/&(?:[a-z]|#)/i.test(residue)) unsupported('Unsupported web entry URL character reference');
    return value.replace(pattern, (entity, numeric, named, legacy) => {
      if (numeric) {
        const code = numeric[0].toLowerCase() === 'x' ? parseInt(numeric.slice(1), 16) : Number(numeric);
        if (!code || code > 0x10ffff || code >= 0xd800 && code <= 0xdfff || code >= 0x80 && code <= 0x9f) fail('Invalid web entry URL entity');
        return String.fromCodePoint(code);
      }
      const key = named ?? legacy;
      if (!Object.hasOwn(entities, key)) unsupported('Unsupported web entry URL entity: ' + entity);
      return entities[key];
    });
  };
  let i = 0;
  while ((i = html.indexOf('<', i)) !== -1) {
    if (html.startsWith('<!--', i)) {
      if (/^<!--(?:>|->)/.test(html.slice(i))) unsupported('Abrupt web index comment ending');
      const end = html.indexOf('-->', i + 4);
      const alternate = html.indexOf('--!>', i + 4);
      const nested = html.indexOf('<!--', i + 4);
      if (end < 0 || alternate !== -1 && alternate < end || nested !== -1 && nested < end) unsupported('Nonstandard or unterminated web index comment');
      i = end + 3;
      continue;
    }
    if (html.startsWith('<!', i)) {
      const doctype = /^<!doctype[ \t\n\f\r]+html[ \t\n\f\r]*>/i.exec(html.slice(i));
      if (!doctype) unsupported('Unsupported web index markup declaration');
      i += doctype[0].length;
      continue;
    }
    if (html.startsWith('</', i)) {
      const closing = /^<\/[a-z][a-z0-9:-]*[ \t\n\f\r]*>/i.exec(html.slice(i));
      if (!closing) unsupported('Nonstandard web index closing tag');
      i += closing[0].length;
      continue;
    }
    const start = /^<([a-z][a-z0-9:-]*)/i.exec(html.slice(i));
    if (!start || !/[ \t\n\f\r/>]/.test(html[i + start[0].length] ?? '')) unsupported('Unsupported web index markup or tag name');
    const tag = start[1].toLowerCase(), attrs = new Map();
    i += start[0].length;
    let ended = false;
    while (i < html.length) {
      while (i < html.length && whitespace.test(html[i])) i++;
      if (html[i] === '>') { i++; ended = true; break; }
      if (html[i] === '/' && html[i + 1] === '>') { i += 2; ended = true; break; }
      const name = /^[^ \t\n\f\r=/>"'<]+/.exec(html.slice(i));
      if (!name) unsupported('Malformed web index tag attributes');
      i += name[0].length;
      while (i < html.length && whitespace.test(html[i])) i++;
      let value = '';
      if (html[i] === '=') {
        i++;
        while (i < html.length && whitespace.test(html[i])) i++;
        const quote = html[i];
        if (quote === '"' || quote === "'") {
          const end = html.indexOf(quote, i + 1);
          if (end < 0) unsupported('Unterminated web index attribute');
          value = html.slice(i + 1, end); i = end + 1;
        } else {
          const unquoted = /^[^ \t\n\f\r>"'=<>`]+/.exec(html.slice(i));
          if (!unquoted) unsupported('Malformed unquoted web index attribute');
          value = unquoted[0]; i += value.length;
        }
      }
      const key = name[0].toLowerCase();
      if (attrs.has(key)) unsupported('Duplicate web index attribute: ' + key);
      attrs.set(key, value);
    }
    if (!ended) unsupported('Unterminated web index tag');
    if (tag === 'base' && attrs.has('href')) unsupported('Web index base URLs require browser validation');
    if (['template', 'svg', 'math'].includes(tag)) unsupported('Unsupported web index container: ' + tag);
    if (tag === 'script' && attrs.has('src')) references.push({ kind: 'script', url: trimUrl(decode(attrs.get('src'))) });
    if (tag === 'link') {
      const rel = decode(attrs.get('rel') ?? '').toLowerCase().split(/[ \t\n\f\r]+/);
      const kind = rel.includes('modulepreload') ? 'modulepreload' : rel.includes('stylesheet') ? 'stylesheet' : null;
      if (kind) {
        if (!attrs.has('href')) fail('Missing web entry asset URL: ' + kind);
        references.push({ kind, url: trimUrl(decode(attrs.get('href'))) });
      }
    }
    if (['script', 'style', 'title', 'textarea', 'noscript'].includes(tag)) {
      const end = new RegExp('</' + tag, 'gi');
      end.lastIndex = i;
      const closing = end.exec(html);
      if (!closing) unsupported('Unterminated web index raw text: ' + tag);
      const ordinary = new RegExp('^</' + tag + '[ \\t\\n\\f\\r]*>', 'i').exec(html.slice(closing.index));
      if (!ordinary) unsupported('Nonstandard web index raw-text closing tag: ' + tag);
      if (tag === 'script' && /<!--|-->/.test(html.slice(i, closing.index))) unsupported('Legacy escaped script text requires browser validation');
      i = closing.index + ordinary[0].length;
    }
    if (references.length > 1000) fail('Too many web entry assets');
  }
  return references;
}
export async function auditWebEntryAssets(fs) {
  const references = webEntryReferences((await fs.read('web/index.html')).toString('utf8'));
  const root = await fs.realpath('web'), entries = [], limits = [];
  for (const { kind, url } of references) {
    if (!url || /[\\\u0000-\u001f\u007f]/.test(url)) fail('Invalid web entry asset URL: ' + url);
    if (/^(?:https?:|data:|blob:|\/\/)/i.test(url)) {
      limits.push({ kind, reason: 'Non-local entry URL was not fetched or validated' });
      continue;
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) fail('Unsupported web entry asset URL scheme: ' + url);
    let decoded;
    try { decoded = decodeURIComponent(url.split(/[?#]/, 1)[0]); } catch { fail('Invalid encoded web entry asset URL: ' + url); }
    if (!decoded || /[\\\u0000-\u001f\u007f]/.test(decoded)) fail('Invalid decoded web entry asset URL: ' + url);
    const local = clean(decoded.startsWith('/') ? decoded.slice(1) : decoded);
    const file = 'web/' + local;
    if (await fs.kind(file) !== 'file') fail('Missing web entry asset: ' + file);
    const resolved = await fs.realpath(file);
    if (!resolved.startsWith(root + '/')) fail('Web entry asset escapes web root: ' + file);
    const bytes = await fs.read(file);
    entries.push({ kind, url, path: file, resolved, bytes: bytes.length, sha256: sha(bytes) });
  }
  return {
    entries, limits, runtimeProven: false,
    limitations: ['Ordinary Vite HTML entry syntax is supported; ambiguous or unsupported HTML grammar fails closed.', 'Only explicit index script/modulepreload/stylesheet files checked; transitive JavaScript/CSS imports, dynamic loads, URL base behavior and browser execution remain unproved.']
  };
}
export async function inspectPackagedArtifact(appBundle, repo, {
  arch = 'arm64'
} = {}) {
  const physical = await auditPhysicalBundle(appBundle),
    resources = physical.resources,
    archivePath = path.join(resources, 'app.asar');
  const require = createRequire(path.join(repo, 'apps/desktop/package.json'));
  let asar;
  try {
    asar = require('@electron/asar');
  } catch {
    const builderRequire = createRequire(require.resolve('electron-builder'));
    asar = builderRequire('@electron/asar');
  }
  const raw = asar.getRawHeader(archivePath);
  // Official @electron/asar's disk.readFileSync starts packed bytes after
  // the 8-byte size pickle and headerSize bytes of header pickle.
  if (!Number.isSafeInteger(raw.headerSize) || raw.headerSize < 0) fail('Invalid archive header size');
  const payloadSize = (await lstat(archivePath)).size - 8 - raw.headerSize;
  const archive = validateArchiveHeader(raw.header, {
    payloadSize
  });
  const unpacked = await validateUnpacked(archive, resources);
  const hostFile = async name => {
    const input = path.join(resources, ...clean(name).split('/'));
    try {
      const actual = await realpath(input);
      if (!contained(resources, actual)) fail('Sibling resource escapes Resources: ' + name);
      return {
        path: actual,
        stat: await lstat(actual)
      };
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
      throw error;
    }
  };
  const fs = {
    async realpath(name) {
      name = clean(name);
      if (name === 'app.asar') return name;
      if (name.startsWith('app.asar/')) return 'app.asar/' + archive.resolve(name.slice(9)).path;
      const found = await hostFile(name);
      if (!found) fail('Missing real package path ' + name);
      return path.relative(resources, found.path).split(path.sep).join('/');
    },
    async kind(name) {
      name = clean(name);
      if (name === 'app.asar') return 'directory';
      if (name.startsWith('app.asar/')) {
        try {
          const {
            node
          } = archive.resolve(name.slice(9));
          return node.files ? 'directory' : 'file';
        } catch (error) {
          if (error.message.startsWith('Missing archive')) return null;
          throw error;
        }
      }
      const found = await hostFile(name);
      return found ? found.stat.isFile() ? 'file' : found.stat.isDirectory() ? 'directory' : null : null;
    },
    async read(name) {
      name = clean(name);
      if (name.startsWith('app.asar/')) return asar.extractFile(archivePath, archive.resolve(name.slice(9)).path);
      const found = await hostFile(name);
      if (!found?.stat.isFile()) fail('Missing sibling file ' + name);
      return readFile(found.path);
    },
    async list() {
      return [...archive.entries.keys()].map(name => 'app.asar/' + name).concat(physical.entries.filter(item => item.kind === 'file' && item.path.startsWith('Contents/Resources/')).map(item => item.path.slice(19)));
    }
  };
  for (const name of ['app.asar/dist/main.js', 'app.asar/dist/preload.cjs', 'web/index.html']) if ((await fs.kind(name)) !== 'file') fail('Missing required runtime resource ' + name);
  const web = await auditWebEntryAssets(fs);
  const closure = await auditRuntimeDependencies(fs, {
    arch
  });
  return {
    at: new Date().toISOString(),
    status: 'STRUCTURAL_CHECKS_PASS_RUNTIME_NOT_RUN',
    appBundle,
    arch,
    physical,
    archive: {
      sha256: sha(await readFile(archivePath)),
      entryCount: archive.entries.size,
      validatedUnpackedFiles: unpacked
    },
    closure,
    web,
    runtimeProven: false
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [appBundle, repo, out, arch = 'arm64'] = process.argv.slice(2);
  let result;
  try {
    if (!appBundle?.endsWith('.app') || ![appBundle, repo, out].every(p => path.isAbsolute(p ?? ''))) fail('Use absolute app/repo/output paths');
    result = await inspectPackagedArtifact(appBundle, repo, {
      arch
    });
  } catch (error) {
    result = {
      at: new Date().toISOString(),
      status: error.name === 'InspectorUnsupported' ? 'INSPECTOR_UNSUPPORTED' : error.code === 'MODULE_NOT_FOUND' ? 'INSPECTOR_UNAVAILABLE' : 'STRUCTURAL_CHECK_FAILED',
      error: {
        name: error.name,
        message: error.message,
        stack: error.stack
      },
      runtimeProven: false
    };
    process.exitCode = 1;
  }
  if (out) await writeFile(out, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({
    status: result.status,
    runtimeProven: false,
    out
  }));
}
