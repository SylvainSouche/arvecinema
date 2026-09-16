// Type declarations for static asset imports in the renderer.
// Vite handles these imports at build time; this file just teaches tsc
// that importing a .png / .jpg / .svg returns a string URL.

declare module '*.png' {
  const src: string;
  export default src;
}

declare module '*.jpg' {
  const src: string;
  export default src;
}

declare module '*.jpeg' {
  const src: string;
  export default src;
}

declare module '*.svg' {
  const src: string;
  export default src;
}
