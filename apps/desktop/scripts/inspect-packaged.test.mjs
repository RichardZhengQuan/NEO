import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, access, realpath, lstat, truncate } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { auditPhysicalBundle, validateArchiveHeader, validateUnpacked, auditRuntimeDependencies, inspectPackagedArtifact } from './inspect-packaged.mjs';
const owned = [];
test.after(async () => {
  for (const item of owned) {
    await rm(item, {
      recursive: true,
      force: true
    });
    assert.equal(await access(item).then(() => true, () => false), false, 'fixture must be removed');
  }
});
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'neo692-inspector-')));
  owned.push(root);
  const app = path.join(root, 'NEO.app');
  await mkdir(path.join(app, 'Contents/Resources'), {
    recursive: true
  });
  return {
    root,
    app,
    resources: path.join(app, 'Contents/Resources')
  };
}
const file = () => ({
  size: 0,
  offset: '0'
});
const archive = files => ({
  files
});
function memoryFs(input, links = {}) {
  const map = new Map(Object.entries(input).map(([key, value]) => [key, Buffer.from(typeof value === 'string' ? value : JSON.stringify(value))]));
  const canonical = p => {
    for (let n = 0; n < 40; n++) {
      const item = Object.keys(links).find(k => p === k || p.startsWith(k + '/'));
      if (!item) return p;
      p = links[item] + p.slice(item.length);
    }
    throw new Error('fixture link cycle');
  };
  return {
    async realpath(p) {
      return canonical(p);
    },
    async kind(p) {
      p = canonical(p);
      if (map.has(p)) return 'file';
      return [...map.keys()].some(key => key.startsWith(p + '/')) ? 'directory' : null;
    },
    async read(p) {
      p = canonical(p);
      if (!map.has(p)) throw new Error('missing fixture ' + p);
      return map.get(p);
    },
    async list() {
      return [...map.keys()];
    }
  };
}
function complete() {
  return {
    'app.asar/package.json': {
      name: 'desktop',
      main: 'dist/main.js',
      dependencies: {
        server: '1'
      }
    },
    'app.asar/dist/main.js': '',
    'app.asar/node_modules/server/package.json': {
      name: 'server',
      exports: {
        '.': {
          'neo-source': './src.ts',
          types: './index.d.ts',
          default: './index.js'
        }
      },
      dependencies: {
        tools: '1'
      }
    },
    'app.asar/node_modules/server/index.js': '',
    'app.asar/node_modules/tools/package.json': {
      name: 'tools',
      main: 'index.js'
    },
    'app.asar/node_modules/tools/index.js': ''
  };
}
test('contained internal Framework symlink is allowed', async () => {
  const {
    app
  } = await fixture();
  const frame = path.join(app, 'Contents/Frameworks/F.framework');
  await mkdir(path.join(frame, 'Versions/A'), {
    recursive: true
  });
  await writeFile(path.join(frame, 'Versions/A/F'), 'binary');
  await symlink('A', path.join(frame, 'Versions/Current'));
  await symlink('Versions/Current/F', path.join(frame, 'F'));
  const result = await auditPhysicalBundle(app);
  assert.equal(result.entries.filter(x => x.kind === 'symlink').length, 2);
});
test('physical symlink outside bundle is rejected', async () => {
  const {
    root,
    app,
    resources
  } = await fixture();
  await writeFile(path.join(root, 'outside'), 'x');
  await symlink('../../../outside', path.join(resources, 'escape'));
  await assert.rejects(auditPhysicalBundle(app), /escapes app/);
});
test('Resources symlink into app Frameworks is rejected', async () => {
  const {
    app,
    resources
  } = await fixture();
  await mkdir(path.join(app, 'Contents/Frameworks'), {
    recursive: true
  });
  await writeFile(path.join(app, 'Contents/Frameworks/F'), 'x');
  await symlink('../Frameworks/F', path.join(resources, 'escape'));
  await assert.rejects(auditPhysicalBundle(app), /escapes Resources/);
});
test('dangling physical link is rejected', async () => {
  const {
    app,
    resources
  } = await fixture();
  await symlink('missing', path.join(resources, 'bad'));
  await assert.rejects(auditPhysicalBundle(app), /Broken/);
});
test('internal ASAR package link resolves root-relative', () => {
  const result = validateArchiveHeader(archive({
    store: archive({
      entry: file()
    }),
    link: {
      link: 'store'
    }
  }));
  assert.equal(result.resolve('link/entry').path, 'store/entry');
});
test('ASAR parent traversal rejected', () => assert.throws(() => validateArchiveHeader(archive({
  link: {
    link: '../sibling'
  }
})), /Escaping/));
test('ASAR absolute link rejected', () => assert.throws(() => validateArchiveHeader(archive({
  link: {
    link: '/tmp/external'
  }
})), /Invalid/));
test('ASAR link cycle rejected', () => assert.throws(() => validateArchiveHeader(archive({
  a: {
    link: 'b'
  },
  b: {
    link: 'a'
  }
})), /cycle/));
test('ASAR malicious entry name rejected', () => assert.throws(() => validateArchiveHeader(archive({
  '../bad': file()
})), /entry name/));
test('ASAR dangling link rejected', () => assert.throws(() => validateArchiveHeader(archive({
  link: {
    link: 'missing'
  }
})), /Missing/));
test('missing unpacked sibling rejected', async () => {
  const {
    resources
  } = await fixture();
  const model = validateArchiveHeader(archive({
    addon: {
      size: 1,
      unpacked: true
    }
  }));
  await assert.rejects(validateUnpacked(model, resources), /Missing unpacked/);
});
test('unpacked link into other Resources sibling rejected', async () => {
  const {
    resources
  } = await fixture();
  await mkdir(path.join(resources, 'app.asar.unpacked'));
  await writeFile(path.join(resources, 'other'), 'x');
  await symlink('../other', path.join(resources, 'app.asar.unpacked/addon'));
  const model = validateArchiveHeader(archive({
    addon: {
      size: 1,
      unpacked: true
    }
  }));
  await assert.rejects(validateUnpacked(model, resources), /escapes matching/);
});
test('contained unpacked sibling validates exact size', async () => {
  const {
    resources
  } = await fixture();
  await mkdir(path.join(resources, 'app.asar.unpacked'));
  await writeFile(path.join(resources, 'app.asar.unpacked/addon'), 'x');
  const model = validateArchiveHeader(archive({
    addon: {
      size: 1,
      unpacked: true
    }
  }));
  assert.deepEqual(await validateUnpacked(model, resources), ['addon']);
});
test('transitive production closure checks all manifests', async () => {
  const result = await auditRuntimeDependencies(memoryFs(complete()));
  assert.equal(result.records.length, 3);
  assert.equal(result.edges.length, 2);
  assert.equal(result.runtimeProven, false);
});
test('missing direct production dependency is rejected', async () => {
  const data = complete();
  delete data['app.asar/node_modules/server/package.json'];
  await assert.rejects(auditRuntimeDependencies(memoryFs(data)), /desktop -> server/);
});
test('missing transitive dependency is rejected despite server manifest presence', async () => {
  const data = complete();
  delete data['app.asar/node_modules/tools/package.json'];
  await assert.rejects(auditRuntimeDependencies(memoryFs(data)), /desktop -> server -> tools/);
});
test('missing active runtime export rejected; types/source conditions ignored', async () => {
  const data = complete();
  delete data['app.asar/node_modules/server/index.js'];
  await assert.rejects(auditRuntimeDependencies(memoryFs(data)), /Missing runtime entry\/export/);
});
test('export escaping package is rejected', async () => {
  const data = complete();
  data['app.asar/node_modules/server/package.json'].exports = {
    '.': '../tools/index.js'
  };
  await assert.rejects(auditRuntimeDependencies(memoryFs(data)), /Invalid export/);
});
test('contained sibling Resources/node_modules is resolved without host fallback', async () => {
  const data = complete();
  data['node_modules/tools/package.json'] = data['app.asar/node_modules/tools/package.json'];
  data['node_modules/tools/index.js'] = '';
  delete data['app.asar/node_modules/tools/package.json'];
  delete data['app.asar/node_modules/tools/index.js'];
  const result = await auditRuntimeDependencies(memoryFs(data));
  assert(result.records.some(item => item.path === 'node_modules/tools'));
});
test('pnpm directory links resolve dependencies from canonical packaged location', async () => {
  const data = {
    'app.asar/package.json': {
      name: 'desktop',
      main: 'index.js',
      dependencies: {
        server: '1'
      }
    },
    'app.asar/index.js': '',
    'app.asar/node_modules/.pnpm/server/node_modules/server/package.json': {
      name: 'server',
      main: 'index.js',
      dependencies: {
        tools: '1'
      }
    },
    'app.asar/node_modules/.pnpm/server/node_modules/server/index.js': '',
    'app.asar/node_modules/.pnpm/server/node_modules/tools/package.json': {
      name: 'tools',
      main: 'index.js'
    },
    'app.asar/node_modules/.pnpm/server/node_modules/tools/index.js': ''
  };
  const result = await auditRuntimeDependencies(memoryFs(data, {
    'app.asar/node_modules/server': 'app.asar/node_modules/.pnpm/server/node_modules/server'
  }));
  assert.equal(result.records.length, 3);
});
test('missing required peer is rejected', async () => {
  const data = complete();
  data['app.asar/node_modules/tools/package.json'].peerDependencies = {
    missing: '1'
  };
  await assert.rejects(auditRuntimeDependencies(memoryFs(data)), /tools -> missing/);
});
test('absent optional dependency is explicit limit, never runtime proof', async () => {
  const data = complete();
  data['app.asar/node_modules/tools/package.json'].optionalDependencies = {
    native: '1'
  };
  const result = await auditRuntimeDependencies(memoryFs(data));
  assert.equal(result.runtimeProven, false);
  assert(result.limits.some(item => item.dependency === 'native'));
});
test('wildcard exports need actual matching files', async () => {
  const data = complete();
  data['app.asar/node_modules/tools/package.json'].exports = {
    './*': './dist/*.js'
  };
  await assert.rejects(auditRuntimeDependencies(memoryFs(data)), /Missing wildcard/);
  data['app.asar/node_modules/tools/dist/real.js'] = '';
  const result = await auditRuntimeDependencies(memoryFs(data));
  assert(result.limits.some(item => item.reason.includes('Wildcard')));
});
test('legitimate Babel-style exports array resolves first active node branch', async () => {
  const data = complete();
  data['app.asar/node_modules/tools/package.json'].exports = {
    '.': [{
      node: './index.js',
      import: './missing-esm.js',
      default: './index.js'
    }, './missing-fallback.js']
  };
  const result = await auditRuntimeDependencies(memoryFs(data));
  assert.equal(result.records.length, 3);
});
test('exports array skips invalid targets', async () => {
  const data = complete();
  data['app.asar/node_modules/tools/package.json'].exports = ['../invalid', './index.js'];
  await auditRuntimeDependencies(memoryFs(data));
});
test('exports array does not skip a valid but missing selected file', async () => {
  const data = complete();
  data['app.asar/node_modules/tools/package.json'].exports = ['./missing.js', './index.js'];
  await assert.rejects(auditRuntimeDependencies(memoryFs(data)), /Missing runtime entry/);
});
test('platform-incompatible present optional binary is explicitly excluded', async () => {
  const data = complete();
  data['app.asar/node_modules/tools/package.json'].optionalDependencies = {
    windows: '1'
  };
  data['app.asar/node_modules/windows/package.json'] = {
    name: 'windows',
    os: ['win32'],
    main: 'missing-on-this-platform.js'
  };
  const result = await auditRuntimeDependencies(memoryFs(data));
  assert(result.limits.some(item => item.dependency === 'windows' && item.reason.includes('excluded')));
  assert.equal(result.runtimeProven, false);
});
test('empty and null arrays remain explicitly unproved exports', async () => {
  for (const value of [[], [null], ['../invalid', []]]) {
    const data = complete();
    data['app.asar/node_modules/tools/package.json'].exports = value;
    const result = await auditRuntimeDependencies(memoryFs(data));
    assert(result.limits.some(item => item.reason.startsWith('No active node export')));
    assert.equal(result.runtimeProven, false);
  }
});
function babelExports() {
  const data = complete();
  data['app.asar/node_modules/tools/package.json'].exports = {
    './regenerator': './regenerator/index.js',
    './regenerator/*.js': './regenerator/*.js',
    './regenerator/': './regenerator/'
  };
  data['app.asar/node_modules/tools/regenerator/index.js'] = '';
  return data;
}
test('Babel legacy folder export is unreachable, with an explicit limitation', async () => {
  const result = await auditRuntimeDependencies(memoryFs(babelExports()));
  const skipped = result.limits.filter(item => item.subpath === './regenerator/');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /unreachable/);
  assert.equal(result.runtimeProven, false);
  const record = result.records.find(item => item.name === 'tools');
  assert(record.targets.some(item => item.subpath === './regenerator'));
  assert(!record.targets.some(item => item.subpath === './regenerator/'));
});
test('missing reachable Babel entry still fails beside the legacy folder key', async () => {
  const data = babelExports();
  delete data['app.asar/node_modules/tools/regenerator/index.js'];
  await assert.rejects(auditRuntimeDependencies(memoryFs(data)), /Missing runtime entry\/export/);
});
test('reachable export targeting a present directory is rejected', async () => {
  const data = complete();
  data['app.asar/node_modules/tools/package.json'].exports = {
    './entry': './directory/'
  };
  data['app.asar/node_modules/tools/directory/index.js'] = '';
  await assert.rejects(auditRuntimeDependencies(memoryFs(data)), /Missing runtime entry\/export/);
});
test('pattern keys ending in slash are not silently skipped', async () => {
  const data = complete();
  data['app.asar/node_modules/tools/package.json'].exports = {
    './folder/*/': './missing/*/'
  };
  await assert.rejects(auditRuntimeDependencies(memoryFs(data)), /Missing wildcard/);
});
test('packed archive offsets and ranges are validated', () => {
  for (const offset of [undefined, 0, '-1', '1x', '01', '9007199254740992']) {
    assert.throws(() => validateArchiveHeader(archive({
      entry: {
        size: 1,
        offset
      }
    }), {
      payloadSize: 4
    }), /Invalid packed archive offset/);
  }
  for (const [offset, size] of [['4', 1], ['5', 0], ['1', 4]]) {
    assert.throws(() => validateArchiveHeader(archive({
      entry: {
        size,
        offset
      }
    }), {
      payloadSize: 4
    }), /exceeds payload/);
  }
  assert.doesNotThrow(() => validateArchiveHeader(archive({
    entry: {
      size: 4,
      offset: '0'
    }
  }), {
    payloadSize: 4
  }));
  assert.throws(() => validateArchiveHeader(archive({}), {
    payloadSize: -1
  }), /payload size/);
});
test('mixed archive node types are rejected', () => {
  for (const entry of [{
    files: {},
    size: 0
  }, {
    files: {},
    offset: '0'
  }, {
    files: {},
    link: 'entry'
  }, {
    link: 'entry',
    size: 0
  }, {
    link: 'entry',
    offset: '0'
  }]) {
    assert.throws(() => validateArchiveHeader(archive({
      entry
    })), /mixes/);
  }
});
async function realArchiveFixture() {
  const require = createRequire(import.meta.url);
  let asar;
  try {
    asar = require('@electron/asar');
  } catch {
    asar = createRequire(require.resolve('electron-builder'))('@electron/asar');
  }
  const item = await fixture();
  const source = path.join(item.root, 'source');
  await mkdir(path.join(source, 'dist'), {
    recursive: true
  });
  await writeFile(path.join(source, 'package.json'), JSON.stringify({
    name: 'fixture',
    main: 'dist/main.js'
  }));
  await writeFile(path.join(source, 'dist/main.js'), '// main fixture bytes');
  await writeFile(path.join(source, 'dist/preload.cjs'), '// preload fixture bytes');
  await mkdir(path.join(item.resources, 'web'));
  await writeFile(path.join(item.resources, 'web/index.html'), '<html>fixture</html>');
  const archivePath = path.join(item.resources, 'app.asar');
  await asar.createPackage(source, archivePath);
  return {
    ...item,
    archivePath,
    asar,
    repo: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
  };
}
test('generated real ASAR passes structural inspection without launching code', async () => {
  const item = await realArchiveFixture();
  const result = await inspectPackagedArtifact(item.app, item.repo);
  assert.equal(result.status, 'STRUCTURAL_CHECKS_PASS_RUNTIME_NOT_RUN');
  assert.equal(result.runtimeProven, false);
});
test('truncated real ASAR payload is rejected before required entries count as present', async () => {
  const item = await realArchiveFixture();
  await truncate(item.archivePath, (await lstat(item.archivePath)).size - 1);
  item.asar.uncache(item.archivePath);
  await assert.rejects(inspectPackagedArtifact(item.app, item.repo), /Packed archive file exceeds payload/);
});
