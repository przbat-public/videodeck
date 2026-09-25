import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractYoutubeVideoId } from '@videodeck/shared/youtube';
import { describe, expect, it } from 'vitest';

/**
 * Manifest invariants. The content script only runs on hosts listed in
 * `content_scripts.matches`, so a host missing there is a page the popup can
 * never read a video from, no matter how good the detection logic is. The
 * matches and the shared URL rule therefore have to stay in step.
 */

interface Manifest {
  minimum_chrome_version?: string;
  content_scripts: Array<{ matches: string[] }>;
}

const manifest = JSON.parse(
  readFileSync(fileURLToPath(new URL('../manifest.json', import.meta.url)), 'utf-8'),
) as Manifest;

/** The hostname of every match pattern the content script declares. */
function contentScriptHosts(): string[] {
  return manifest.content_scripts.flatMap((entry) =>
    entry.matches.map((pattern) => new URL(pattern.split('/').slice(0, 3).join('/')).hostname),
  );
}

describe('extension manifest', () => {
  it('injects the content script on youtu.be short links', () => {
    expect(contentScriptHosts()).toContain('youtu.be');
  });

  it('only matches hosts the shared URL rule recognises', () => {
    for (const host of contentScriptHosts()) {
      expect(extractYoutubeVideoId(`https://${host}/watch?v=dQw4w9WgXcQ`)).toBe('dQw4w9WgXcQ');
    }
  });

  it('declares the Chrome version the storage.session API needs', () => {
    // background.ts keeps its active-download snapshot in chrome.storage.session,
    // which landed in Chrome 102; Chrome refuses to install the extension below
    // the declared floor.
    expect(Number(manifest.minimum_chrome_version)).toBeGreaterThanOrEqual(102);
  });
});
