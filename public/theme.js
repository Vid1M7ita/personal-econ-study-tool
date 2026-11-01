// Dark is the default. A visitor who picks light keeps it on later visits.
// Storage can be blocked (private windows, strict settings), so every access is guarded.
(function () {
  var theme = "dark";
  try {
    var saved = localStorage.getItem("sbe-theme");
    if (saved === "light" || saved === "dark") theme = saved;
  } catch (e) {}
  document.documentElement.setAttribute("data-theme", theme);
})();
