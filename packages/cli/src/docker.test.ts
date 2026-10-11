import { execFile, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, it } from 'vitest';

// Builds the full image (minutes): opt in with NEO_DOCKER_TEST=1, e.g. `NEO_DOCKER_TEST=1 pnpm --filter @neo/cli test docker`.
const enabled = process.env['NEO_DOCKER_TEST'] === '1';
const dockerAvailable = enabled && spawnSync('docker', ['version'], { stdio: 'ignore', timeout: 5000 }).status === 0;
const run = promisify(execFile);
const root = fileURLToPath(new URL('../../../', import.meta.url));

it.skipIf(!dockerAvailable)('starts the production Docker image with a fresh data volume and serves health and web', async () => {
  const suffix = `${process.pid}-${Date.now()}`;
  const container = `neo-review-${suffix}`;
  const volume = `neo-review-data-${suffix}`;
  let built = false;
  try {
    await run('docker', ['build', '-t', 'neo-test', '.'], { cwd: root, maxBuffer: 10 * 1024 * 1024 });
    built = true;
    await run('docker', ['run', '-d', '--name', container, '-p', '127.0.0.1::7777', '-v', `${volume}:/data`, 'neo-test']);
    const { stdout } = await run('docker', ['port', container, '7777/tcp']);
    const base = `http://${stdout.trim()}`;
    const deadline = Date.now() + 30_000;
    let health: Response | undefined;
    while (Date.now() < deadline) {
      health = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2000) }).catch(() => undefined);
      if (health?.ok) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(health?.ok).toBe(true);
    expect(await health!.json()).toMatchObject({ ok: true, name: 'neo', mode: 'server' });
    const page = await fetch(base, { signal: AbortSignal.timeout(5000) });
    expect(page.status).toBe(200);
    expect(await page.text()).toContain('<html');
  } finally {
    await run('docker', ['rm', '-f', container]).catch(() => undefined);
    await run('docker', ['volume', 'rm', volume]).catch(() => undefined);
    if (built) await run('docker', ['image', 'rm', 'neo-test']).catch(() => undefined);
  }
}, 600_000);
