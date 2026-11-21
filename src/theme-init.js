// Runs before the page paints so night-mode visitors never see a white flash.
try {
  var t = localStorage.getItem("moralume.theme");
  if (!t) t = window.matchMedia && matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  document.documentElement.dataset.theme = t;
} catch (e) {}
