/**
 * Valpovački AI gradski informator — embed widget za gradsko web sjedište.
 *
 * Ugradnja (jedan redak prije </body>):
 *   <script src="https://VAŠA-DOMENA.vercel.app/widget.js" defer></script>
 *
 * Skripta dodaje plutajući gumb u donji desni kut; klik otvara chat u iframeu.
 * Dopuštene roditeljske domene definirane su CSP-om (frame-ancestors) na /widget.
 */
(function () {
  'use strict';

  var BASE = (function () {
    var s = document.currentScript;
    try { return new URL(s.src).origin; } catch (e) { return ''; }
  })();

  var open = false;

  var button = document.createElement('button');
  button.setAttribute('aria-label', 'Otvori gradski AI informator');
  button.textContent = '💬 Pitajte Grad';
  button.style.cssText =
    'position:fixed;right:20px;bottom:20px;z-index:99998;padding:12px 18px;' +
    'background:#014128;color:#fff;border:none;border-radius:24px;font-size:15px;' +
    'font-family:system-ui,sans-serif;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.25);';

  var frame = document.createElement('iframe');
  frame.src = BASE + '/widget';
  frame.title = 'Valpovački AI gradski informator';
  frame.style.cssText =
    'position:fixed;right:20px;bottom:76px;z-index:99999;width:380px;height:560px;' +
    'max-width:calc(100vw - 40px);max-height:calc(100vh - 100px);border:1px solid #cdd9d2;' +
    'border-radius:12px;box-shadow:0 8px 24px rgba(0,0,0,.3);display:none;background:#fff;';

  button.addEventListener('click', function () {
    open = !open;
    frame.style.display = open ? 'block' : 'none';
    button.textContent = open ? '✕ Zatvori' : '💬 Pitajte Grad';
  });

  document.body.appendChild(button);
  document.body.appendChild(frame);
})();
