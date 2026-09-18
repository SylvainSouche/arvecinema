// Shared User-Agent string using the real app version.
// Injected at build time by Vite via __APP_VERSION__ define.
declare const __APP_VERSION__: string;

export const APP_USER_AGENT = `ArveCinema/${typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '1.0.0'}`;
