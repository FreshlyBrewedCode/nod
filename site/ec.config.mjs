import { defineEcConfig } from "astro-expressive-code";

/*
 * Expressive Code lives here rather than in `astro.config.mjs` because
 * `themeCssSelector` is a function, and the `<Code>` component needs options
 * it can serialise. The integration picks this file up automatically.
 */
export default defineEcConfig({
  // The light theme is first, so it renders as the unscoped base — which is
  // what the site's class-only dark mode needs (no `.light` class exists).
  // `.dark` then overrides it, matching `@custom-variant dark` in global.css.
  themes: ["min-light", "min-dark"],
  themeCssSelector: (theme) => `.${theme.type}`,
  useDarkModeMediaQuery: false,
  styleOverrides: {
    // The app's panels: one step off the page, a hairline, a soft corner.
    borderRadius: "10px",
    borderColor: "var(--border)",
    codeBackground: "var(--card)",
    codeFontFamily: "var(--font-mono)",
    codeFontSize: "0.8125rem",
    uiFontFamily: "var(--font-sans)",
    frames: {
      frameBoxShadowCssValue: "none",
      editorActiveTabBackground: "var(--card)",
      editorTabBarBackground: "var(--muted)",
      editorTabBarBorderBottomColor: "var(--border)",
      editorActiveTabIndicatorTopColor: "var(--primary)",
      editorActiveTabBorderColor: "var(--border)",
      terminalBackground: "var(--card)",
      terminalTitlebarBackground: "var(--muted)",
      terminalTitlebarBorderBottomColor: "var(--border)",
      terminalTitlebarDotsOpacity: "0",
    },
  },
});
