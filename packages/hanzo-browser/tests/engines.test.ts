import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findEngineBinary } from '../src/engines.js';

describe('findEngineBinary', () => {
  const saved = { ...process.env };
  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...saved };
  });

  it('falls back to the newest Chromium Playwright installed when no system Chrome exists', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-'));
    for (const rev of ['chromium-1148', 'chromium-1243']) {
      const bin = path.join(root, rev, 'chrome-linux64', 'chrome');
      fs.mkdirSync(path.dirname(bin), { recursive: true });
      fs.writeFileSync(bin, '');
    }
    process.env = { PATH: '', PLAYWRIGHT_BROWSERS_PATH: root, HOME: root };
    const real = fs.existsSync;
    vi.spyOn(fs, 'existsSync').mockImplementation((p) => String(p).startsWith(root) && real(p));
    expect(findEngineBinary('chrome')).toBe(path.join(root, 'chromium-1243', 'chrome-linux64', 'chrome'));
    fs.rmSync(root, { recursive: true, force: true });
  });
});
