// ──────────────────────────────────────────────────────────────────────────
// Security wiring contract — pins that the validators/policies from items
// SEC-01/IPC-01 actually protect the handlers that need them, and stay
// connected after refactors of main/index.ts.
//
// Source-audit based (same pattern as loggingContract): index.ts cannot be
// imported in vitest (electron), but its wiring is exactly what here is a
// "contract".
//
// What this catches:
//   - a refactor dropping the schedule:fetch / ratings:retry validation
//   - the sender check being removed from privileged handlers
//   - the child-window navigation policy being bypassed (suffix heuristic
//     sneaking back in) or the will-redirect guard being lost
//   - a new screen bypassing the IPC layer to import main modules
// ──────────────────────────────────────────────────────────────────────────

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string): string => fs.readFileSync(path.join(process.cwd(), rel), 'utf8');

describe('security contract: IPC validation boundary wired in main', () => {
  const index = () => read('src/main/index.ts');

  it('schedule:fetch validates cinemaIds through the parse boundary', () => {
    const s = index();
    expect(s).toMatch(/parseCinemaIdsInput\(cinemaIds\)/);
    // the filter must consume the PARSED value, never the raw parameter
    expect(s).toMatch(/cinemaIdParse\.value\.includes\(c\.id\)/);
    expect(s).not.toMatch(/cinemaIds\.includes/);
  });

  it('ratings:retry validates + sanitizes the movie array (no raw casts)', () => {
    const s = index();
    expect(s).toMatch(/parseRetryMoviesInput\(/);
    expect(s).toMatch(/parsed\.ok/);
    expect(s).toMatch(/parsed\.value/);
    // The old blind cast must not come back.
    expect(s).not.toMatch(/moviesFromRenderer as Movie\[\]/);
  });

  it('privileged handlers reject unknown senders (webContents check)', () => {
    const s = index();
    expect(s).toMatch(/function isKnownRendererSender\(/);
    // Guard must be called in both handlers that consume input that
    // triggers network work…
    const fetchGuard = s.match(/schedule:fetch[\s\S]{0,900}isKnownRendererSender\(evt\)/);
    expect(fetchGuard).toBeTruthy();
    const retryGuard = s.match(/ratings:retry[\s\S]{0,1200}isKnownRendererSender\(evt\)/);
    expect(retryGuard).toBeTruthy();
  });
});

describe('security contract: child-window navigation policy', () => {
  const index = () => read('src/main/index.ts');

  it('uses the PSL allow-list policy, not the suffix heuristic', () => {
    const s = index();
    expect(s).toMatch(/isChildNavigationAllowed\(/);
    expect(s).not.toMatch(/isSameRegistrableDomain/); // must not come back
    expect(s).toMatch(/buildAllowedChildDomains\(/);
  });

  it('redirects are revalidated as their own navigation boundary', () => {
    const s = index();
    expect(s).toMatch(/on\('will-redirect', \(event, url\) =>/);
    const block = s.match(/on\('will-redirect'[\s\S]*?\}\);/);
    expect(block?.[0]).toMatch(/isChildNavigationAllowed\(/);
  });

  it('isChildNavigationAllowed itself has no suffix-host logic left', () => {
    const policy = read('src/main/navigationPolicy.ts');
    expect(policy).not.toMatch(/endsWith\('\.' \+/);
    expect(policy).toMatch(/getDomain/);
  });
});

describe('security contract: renderer boundary', () => {
  it('renderer/preload never import main-process modules directly', () => {
    const violations: string[] = [];
    for (const dir of ['src/renderer', 'src/preload']) {
      const walk = (d: string): string[] => {
        let out: string[] = [];
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory() && !p.includes('node_modules')) out = [...out, ...walk(p)];
          else if (p.endsWith('.ts') || p.endsWith('.tsx')) out.push(p);
        }
        return out;
      };
      for (const file of walk(path.join(process.cwd(), dir))) {
        const src = fs.readFileSync(file, 'utf8');
        if (/(?:from|import)\s+['"][^'"]*src\/main\//.test(src) || /from '\.\.?\/\.\.\/main\//.test(src)) {
          violations.push(path.relative(process.cwd(), file));
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
