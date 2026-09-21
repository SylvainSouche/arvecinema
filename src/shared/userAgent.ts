// Shared User-Agent string using the real app version.
// Injected at build time by Vite via __APP_VERSION__ define.
//
// IMPORTANT: Wikimedia (Wikidata, Wikipedia) requires a descriptive
// User-Agent with a contact URL per their UA policy:
//   https://meta.wikimedia.org/wiki/User-Agent_policy
//
// A bare "AppName/1.0" gets 403-blocked. The format must be:
//   "AppName/version (URL-or-email)"
declare const __APP_VERSION__: string;

export const APP_USER_AGENT = `ArveCinema/${
  typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev'
} (https://github.com/SylvainSouche/arvecinema)`;
