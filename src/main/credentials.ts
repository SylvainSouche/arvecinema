import { app } from 'electron';
import path from 'path';
import fs from 'fs';

// ──────────────────────────────────────────────────────────────────────────
// Credentials storage for MPDB.tv API.
//
// The credentials are stored as a JSON file in the user's data directory
// (NOT inside the app bundle, NOT in the repo). On macOS this is
//   ~/Library/Application Support/ArveCinema/credentials.json
//
// Three values are required to call MPDB.tv:
//   - apiKey         : the application's API key (issued by MPDB forum admins)
//   - username       : the user's MPDB.tv account login
//   - subscriptionKey : the user's subscription key (visible in their MPDB account)
//
// The `subscriptionKey` field combined with `username` + `apiKey` is used
// to compute the SUBSCRIPTIONKEY hash expected by the API:
//   sha1(username_lowercase + apiKey + subscriptionKey).toUpperCase()
// ──────────────────────────────────────────────────────────────────────────

export interface MpdbCredentials {
  apiKey: string;
  username: string;
  subscriptionKey: string;
}

const CREDENTIALS_FILENAME = 'credentials.json';

function credentialsPath(): string {
  // app.getPath('userData') returns e.g.
  //   macOS: ~/Library/Application Support/ArveCinema
  //   Linux: ~/.config/ArveCinema
  //   Windows: %APPDATA%\ArveCinema
  return path.join(app.getPath('userData'), CREDENTIALS_FILENAME);
}

/** Read the stored credentials. Returns null if missing or malformed. */
export function readCredentials(): MpdbCredentials | null {
  try {
    const raw = fs.readFileSync(credentialsPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (
      typeof parsed.apiKey === 'string' &&
      typeof parsed.username === 'string' &&
      typeof parsed.subscriptionKey === 'string'
    ) {
      return parsed as MpdbCredentials;
    }
    return null;
  } catch {
    return null;
  }
}

/** Persist credentials to disk. The file is created with mode 0600 so only
 *  the current user can read it. */
export function writeCredentials(creds: MpdbCredentials): void {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(credentialsPath(), JSON.stringify(creds, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

/** Are credentials currently configured? */
export function hasCredentials(): boolean {
  return readCredentials() !== null;
}

/** Compute the SUBSCRIPTIONKEY hash required by the MPDB API.
 *
 *  Per the API docs:
 *    SUBSCRIPTIONKEY = sha1(username_lowercase + apiKey + subscriptionKey).toUpperCase()
 *
 *  Combined with B64USERNAME (base64 of the login), this lets us call the
 *  authenticated endpoints without sending the password in clear text. */
export function computeSubscriptionHash(creds: MpdbCredentials): string {
  const crypto = require('crypto') as typeof import('crypto');
  const raw = `${creds.username.toLowerCase()}${creds.apiKey}${creds.subscriptionKey}`;
  return crypto.createHash('sha1').update(raw).digest('hex').toUpperCase();
}

/** Base64url-encoded username (the B64USERNAME path segment expected by MPDB).
 *  Uses base64url so the result is safe in a URL path. */
export function computeB64Username(creds: MpdbCredentials): string {
  // MPDB's PHP example uses plain base64 of the login. We convert to
  // base64url (replace + / = with URL-safe chars) so the result is safe in
  // a URL path segment.
  const b64 = Buffer.from(creds.username).toString('base64');
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
