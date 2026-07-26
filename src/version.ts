import * as fs from 'node:fs/promises';

/**
 * Read the package version at runtime rather than baking it in at build time.
 *
 * `../package.json` resolves correctly from both `dist/version.js` and `src/version.ts`,
 * so the number is right whether the CLI is running from a build or straight from
 * source during development.
 */
let cached: string | null = null;

export async function readVersion(): Promise<string> {
  if (cached !== null) return cached;
  try {
    const url = new URL('../package.json', import.meta.url);
    const raw = await fs.readFile(url, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    cached = typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}
