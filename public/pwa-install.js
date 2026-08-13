/* Chausar — PWA install helper (self-contained, no dependencies)
 * - Android/Chromium: captures `beforeinstallprompt` and shows an Install button.
 * - iOS Safari: shows a dismissible "Add to Home Screen" hint.
 * - Hides itself when already installed (standalone) or after dismissal.
 * - Reads `data-accent` from its own <script> tag (default: #C8A24B).
 * © agapps
 */
(function () {
  "use strict";

  var me =
    document.currentScript ||
    (function () {
      var s = document.getElementsByTagName("script");
      return s[s.length - 1];
    })();
  var ACCENT = (me && me.getAttribute("data-accent")) || "#C8A24B";
  var DISMISS_KEY = "lu_pwa_dismissed";

  function isStandalone() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
    );
  }

  function isIOS() {
    var ua = window.navigator.userAgent || "";
    var iDevice = /iPad|iPhone|iPod/.test(ua);
    // iPadOS 13+ reports as Mac; detect touch-capable Safari.
    var iPadOS =
      navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1;
    var isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|Chrome/.test(ua);
    return (iDevice || iPadOS) && isSafari;
  }

  function dismissed() {
    try {
      return localStorage.getItem(DISMISS_KEY) === "1";
    } catch (e) {
      return false;
    }
  }

  function markDismissed() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch (e) {}
  }

  function injectStyles() {
    if (document.getElementById("lu-pwa-style")) return;
    var css =
      ".lu-pwa{position:fixed;left:12px;right:12px;bottom:calc(12px + env(safe-area-inset-bottom));" +
      "z-index:2147483000;display:flex;align-items:center;gap:12px;max-width:520px;margin:0 auto;" +
      "padding:12px 14px;border-radius:16px;background:rgba(14,17,22,.96);color:#F5F7FA;" +
      "border:1px solid rgba(255,255,255,.12);box-shadow:0 10px 30px rgba(0,0,0,.45);" +
      "font:500 14px/1.35 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;" +
      "transform:translateY(140%);transition:transform .28s ease;}" +
      ".lu-pwa.bb-show{transform:translateY(0)}" +
      "@media (prefers-reduced-motion:reduce){.lu-pwa{transition:none}}" +
      ".lu-pwa__ico{flex:0 0 auto;width:34px;height:34px;border-radius:9px;" +
      "background:" + ACCENT + ";color:#0E1116;display:flex;align-items:center;justify-content:center;" +
      "font-size:19px;font-weight:800}" +
      ".lu-pwa__txt{flex:1 1 auto;min-width:0}" +
      ".lu-pwa__txt b{display:block;font-weight:700}" +
      ".lu-pwa__txt span{display:block;opacity:.8;font-weight:500;font-size:12.5px}" +
      ".lu-pwa__btn{flex:0 0 auto;appearance:none;border:0;cursor:pointer;" +
      "min-height:40px;padding:0 16px;border-radius:11px;font:700 14px system-ui,sans-serif;" +
      "background:" + ACCENT + ";color:#0E1116}" +
      ".lu-pwa__btn:focus-visible,.lu-pwa__x:focus-visible{outline:3px solid " + ACCENT + ";outline-offset:2px}" +
      ".lu-pwa__x{flex:0 0 auto;appearance:none;border:0;background:transparent;color:inherit;" +
      "cursor:pointer;width:40px;height:40px;border-radius:11px;font-size:20px;line-height:1;opacity:.7}" +
      ".lu-pwa__x:hover{opacity:1}";
    var st = document.createElement("style");
    st.id = "lu-pwa-style";
    st.textContent = css;
    document.head.appendChild(st);
  }

  function build(opts) {
    injectStyles();
    var bar = document.createElement("div");
    bar.className = "lu-pwa";
    bar.setAttribute("role", "dialog");
    bar.setAttribute("aria-label", "Install Chausar");

    var ico = document.createElement("div");
    ico.className = "lu-pwa__ico";
    ico.textContent = "♛"; // crown glyph
    bar.appendChild(ico);

    var txt = document.createElement("div");
    txt.className = "lu-pwa__txt";
    var b = document.createElement("b");
    b.textContent = "Install Chausar";
    var sp = document.createElement("span");
    sp.textContent = opts.hint;
    txt.appendChild(b);
    txt.appendChild(sp);
    bar.appendChild(txt);

    if (opts.action) {
      var btn = document.createElement("button");
      btn.className = "lu-pwa__btn";
      btn.type = "button";
      btn.textContent = "Install";
      btn.addEventListener("click", opts.action);
      bar.appendChild(btn);
    }

    var x = document.createElement("button");
    x.className = "lu-pwa__x";
    x.type = "button";
    x.setAttribute("aria-label", "Dismiss");
    x.textContent = "×";
    x.addEventListener("click", function () {
      hide(bar);
      markDismissed();
    });
    bar.appendChild(x);

    document.body.appendChild(bar);
    // allow transition
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        bar.classList.add("bb-show");
      });
    });
    return bar;
  }

  function hide(bar) {
    if (!bar) return;
    bar.classList.remove("bb-show");
    setTimeout(function () {
      if (bar.parentNode) bar.parentNode.removeChild(bar);
    }, 320);
  }

  function start() {
    if (isStandalone() || dismissed()) return;

    var deferredPrompt = null;
    var bar = null;

    // Android / Chromium install flow.
    window.addEventListener("beforeinstallprompt", function (e) {
      e.preventDefault();
      deferredPrompt = e;
      if (bar) return;
      bar = build({
        hint: "Add it to your home screen for full-screen play.",
        action: function () {
          if (!deferredPrompt) return;
          deferredPrompt.prompt();
          deferredPrompt.userChoice.finally(function () {
            deferredPrompt = null;
            hide(bar);
          });
        }
      });
    });

    // Clean up if the app gets installed while the banner is open.
    window.addEventListener("appinstalled", function () {
      markDismissed();
      hide(bar);
    });

    // iOS Safari has no beforeinstallprompt — show a manual hint.
    if (isIOS()) {
      // slight delay so it doesn't fight the first paint
      setTimeout(function () {
        if (isStandalone() || dismissed() || bar) return;
        bar = build({
          hint: "Tap the Share icon, then “Add to Home Screen”.",
          action: null
        });
      }, 1200);
    }
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
