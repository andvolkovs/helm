// Theme before first paint, so the page doesn't flash Harbor first (see src/ui/themes.ts).
// Loaded as a plain blocking script from index.html.
try {
  var theme = localStorage.getItem('helm.theme');
  if (theme && /^[a-z]+$/.test(theme)) document.documentElement.dataset.theme = theme;
} catch (e) {}
