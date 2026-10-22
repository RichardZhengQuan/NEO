/**
 * Generate desktop icons from the canonical site/favicon.svg.
 * @resvg/resvg-js rasterizes SVG deterministically; png2icons assembles ICNS
 * and ICO files in pure JavaScript. resvg-js uses npm-packaged native Node
 * bindings, not WASM, without a separate native download or post-install build.
 * Neither tool needs Electron, so CI can use ELECTRON_SKIP_BINARY_DOWNLOAD=1.
 * No timestamps or other changing metadata are added to the outputs.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '../../..');
const buildDir = path.resolve(scriptDir, '../build');
const rasterSizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const linuxSizes = [16, 32, 48, 64, 128, 256, 512];

async function writeOutput(filePath, buffer) {
  await writeFile(filePath, buffer);
  const relativePath = path.relative(repoRoot, filePath).split(path.sep).join('/');
  console.log(`wrote ${relativePath} (${buffer.length} bytes)`);
}

async function generateIcons() {
  // Load inside the caught operation so missing dependencies also fail clearly.
  const { Resvg } = await import('@resvg/resvg-js');
  const { default: png2icons } = await import('png2icons');
  const svg = await readFile(path.join(repoRoot, 'site/favicon.svg'), 'utf8');
  const pngs = new Map();

  for (const size of rasterSizes) {
    const resvg = new Resvg(svg, {
      fitTo: { mode: 'width', value: size },
      background: undefined,
    });
    pngs.set(size, resvg.render().asPng());
  }

  const icns = png2icons.createICNS(pngs.get(1024), png2icons.BICUBIC, 0);
  if (!icns) throw new Error('png2icons.createICNS failed to assemble the macOS icon');

  const ico = png2icons.createICO(pngs.get(256), png2icons.BICUBIC, 0, false);
  if (!ico) throw new Error('png2icons.createICO failed to assemble the Windows icon');

  const iconsDir = path.join(buildDir, 'icons');
  await mkdir(iconsDir, { recursive: true });
  for (const size of linuxSizes) {
    await writeOutput(path.join(iconsDir, `${size}x${size}.png`), pngs.get(size));
  }
  await writeOutput(path.join(buildDir, 'icon.icns'), icns);
  await writeOutput(path.join(buildDir, 'icon.ico'), ico);
}

try {
  await generateIcons();
} catch (error) {
  console.error('Failed to generate desktop icons:', error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
