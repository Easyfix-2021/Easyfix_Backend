const path = require('node:path');
const fs = require('node:fs');
const yaml = require('js-yaml');
const swaggerUi = require('swagger-ui-express');

const { buildOpenApiPaths } = require('./openapi-autogen');

/*
 * EasyFix Swagger UI extensions — three pinned buttons (Quick Login,
 * Token Inspector, Logout) and a shared modal scaffolding.
 *
 * Why modal instead of `prompt`/`alert`: native browser dialogs steal focus
 * across tabs and look out of place against swagger-ui's React UI. The
 * modal lives outside the React tree (`document.body.appendChild`) so
 * swagger-ui re-renders never blow it away.
 *
 * Quick Login walks through CRM / Technician / Client SPOC and pre-
 * authorises the matching `bearer*` scheme via
 * `window.ui.preauthorizeApiKey(scheme, token)`.
 *
 * Token Inspector reads from `localStorage.authorized` (the same store
 * swagger-ui maintains when `persistAuthorization: true`), decodes the
 * JWT payload of every active Bearer scheme, and renders the claims +
 * expiry countdown.
 *
 * Logout calls `window.ui.authActions.logout([…])` (the supported API)
 * plus a defensive localStorage wipe for Private-Browsing edge cases.
 *
 * Base URL = `window.location.origin + '/api'` so the buttons always hit
 * the same host the docs are served from — the server-dropdown is ignored
 * on purpose (logging into env A's OTP flow and trying it against env B's
 * host wouldn't work anyway).
 *
 * No bundler / no external deps; plain ES5-friendly JS so swagger-ui's
 * runtime can eval it.
 */
const QUICK_LOGIN_JS = `
(function () {
  var SCHEMES = ['bearerAdmin', 'bearerTech', 'bearerClient', 'basicIntegration'];
  var BEARER_SCHEMES = ['bearerAdmin', 'bearerTech', 'bearerClient'];

  // identifierField MATTERS — each tier's BE Joi validator expects a
  // different field name in the request body:
  //   CRM       → POST /auth/login-otp        body: { identifier, otp? }
  //   Tech      → POST /mobile/auth/login-otp body: { mobile,     otp? }
  //   ClientSPOC→ POST /client/auth/login-otp body: { identifier, otp? }
  // A mismatch produces a 400 "Validation failed" — caught in production
  // 2026-05-28 when Quick Login on Tech tier hit /mobile/auth/login-otp
  // with { identifier: '9731446014' } and Joi rejected it.
  //
  // placeholder + accepts describe the input UI hint per tier; mobile-only
  // tiers (Tech) get a numeric inputmode and a 10-digit constraint message.
  var TIERS = {
    bearerAdmin: {
      prefix: '/auth',
      label: 'CRM (Admin)',
      identifierField: 'identifier',
      placeholder: 'you@channelplay.in or 9999999999',
      accepts: 'Email OR 10-digit Mobile',
    },
    bearerTech: {
      prefix: '/mobile/auth',
      label: 'Technician (Mobile)',
      identifierField: 'mobile',
      placeholder: '9999999999',
      accepts: '10-digit Mobile only',
    },
    bearerClient: {
      prefix: '/client/auth',
      label: 'Client SPOC',
      identifierField: 'identifier',
      placeholder: 'you@example.com or 9999999999',
      accepts: 'Email OR 10-digit Mobile',
    },
  };

  // ── Style injection (one-time) ────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('ef-modal-styles')) return;
    var s = document.createElement('style');
    s.id = 'ef-modal-styles';
    s.textContent = [
      // ── Pinned button cluster — gradient + lift + glow ──
      '.ef-cta{position:fixed;top:14px;z-index:9999;padding:10px 20px;border:none;border-radius:11px;cursor:pointer;font-weight:700;font-size:13px;color:#fff;letter-spacing:.2px;display:inline-flex;align-items:center;gap:6px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;transition:transform .18s cubic-bezier(.34,1.56,.64,1),box-shadow .18s ease,filter .15s ease;box-shadow:0 4px 14px rgba(0,0,0,.18),inset 0 -2px 0 rgba(0,0,0,.12)}',
      '.ef-cta:hover{transform:translateY(-3px) scale(1.02);box-shadow:0 10px 24px rgba(0,0,0,.22),inset 0 -2px 0 rgba(0,0,0,.12);filter:brightness(1.05)}',
      '.ef-cta:active{transform:translateY(-1px) scale(.99)}',
      '.ef-cta-login{background:linear-gradient(135deg,#06b6d4 0%,#3b82f6 50%,#6366f1 100%);animation:efGlow 2.6s ease-in-out infinite}',
      '.ef-cta-token{background:linear-gradient(135deg,#8b5cf6 0%,#ec4899 100%)}',
      '.ef-cta-logout{background:linear-gradient(135deg,#64748b 0%,#475569 100%)}',
      '@keyframes efGlow{0%,100%{box-shadow:0 4px 14px rgba(59,130,246,.35),inset 0 -2px 0 rgba(0,0,0,.12)}50%{box-shadow:0 4px 22px rgba(99,102,241,.7),inset 0 -2px 0 rgba(0,0,0,.12)}}',
      // ── Backdrop + card ──
      '.ef-backdrop{position:fixed;inset:0;background:rgba(15,23,42,.45);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);z-index:99998;display:flex;align-items:center;justify-content:center;animation:efFadeIn .18s ease-out}',
      '.ef-card{background:#fff;border-radius:18px;width:500px;max-width:92vw;max-height:88vh;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 25px 70px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.06);animation:efBounceIn .38s cubic-bezier(.34,1.56,.64,1);font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif}',
      // ── Gradient header with glow accent ──
      '.ef-head{padding:18px 22px;background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 45%,#ec4899 100%);color:#fff;display:flex;align-items:center;justify-content:space-between;position:relative;overflow:hidden}',
      '.ef-head::before{content:"";position:absolute;top:-30%;right:-10%;width:60%;height:160%;background:radial-gradient(circle,rgba(255,255,255,.25) 0%,transparent 60%);pointer-events:none}',
      '.ef-head h3{margin:0;font-size:16px;font-weight:700;letter-spacing:-.2px;position:relative;z-index:1;text-shadow:0 1px 2px rgba(0,0,0,.15)}',
      '.ef-close{background:rgba(255,255,255,.15);border:none;color:#fff;font-size:18px;cursor:pointer;line-height:1;padding:0;width:30px;height:30px;border-radius:8px;position:relative;z-index:1;transition:background .15s,transform .15s}',
      '.ef-close:hover{background:rgba(255,255,255,.28);transform:rotate(90deg)}',
      // ── Body + foot ──
      '.ef-body{padding:22px;overflow:auto;flex:1;font-size:14px;color:#1e293b;line-height:1.55}',
      '.ef-foot{padding:14px 22px;background:linear-gradient(180deg,#f8fafc 0%,#f1f5f9 100%);border-top:1px solid #e2e8f0;display:flex;gap:10px;justify-content:flex-end}',
      // ── Environment picker (Quick Login step 1) ──
      '.ef-env-row{display:flex;flex-direction:column;gap:8px;margin:8px 0 4px}',
      '.ef-env-chip{display:flex;flex-direction:column;align-items:flex-start;gap:2px;width:100%;text-align:left;padding:10px 14px;border:1.5px solid #E6DEDF;border-radius:10px;background:#fff;cursor:pointer;transition:border-color .12s,background .12s;font-family:inherit}',
      '.ef-env-chip:hover{border-color:#C42430;background:#FBEDEE}',
      '.ef-env-chip.on{border-color:#C42430;background:#FBEDEE;box-shadow:inset 3px 0 0 #C42430}',
      '.ef-env-name{font-size:13px;font-weight:600;color:#1A1618}',
      '.ef-env-url{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;color:#6B6167}',
      '.ef-note{font-size:12px;line-height:1.55;color:#8A5A00;background:#FBF1DF;border:1px solid #EBD9B4;border-radius:9px;padding:10px 12px;margin-top:10px}',
      '.ef-tier-basic .ef-tier-icon{background:linear-gradient(135deg,#0f766e,#134e4a)}',
      '.ef-btn-danger-ghost{color:#C42430!important;border-color:#F3C9CC!important}',
      '.ef-btn-danger-ghost:hover{background:#FBEDEE!important;border-color:#C42430!important}',
      // ── Modal buttons ──
      '.ef-btn{padding:9px 18px;border-radius:9px;border:none;cursor:pointer;font-weight:700;font-size:13px;font-family:inherit;transition:all .15s ease;letter-spacing:.15px}',
      '.ef-btn:disabled{opacity:.55;cursor:not-allowed;transform:none!important}',
      '.ef-btn-primary{background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%);color:#fff;box-shadow:0 4px 12px rgba(99,102,241,.35),inset 0 -1px 0 rgba(0,0,0,.1)}',
      '.ef-btn-primary:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(99,102,241,.5),inset 0 -1px 0 rgba(0,0,0,.1)}',
      '.ef-btn-primary:active{transform:translateY(0)}',
      '.ef-btn-ghost{background:#fff;color:#475569;border:1.5px solid #e2e8f0}',
      '.ef-btn-ghost:hover{background:#f8fafc;border-color:#cbd5e1;color:#1e293b}',
      '.ef-btn-danger{background:linear-gradient(135deg,#f43f5e 0%,#dc2626 100%);color:#fff;box-shadow:0 4px 12px rgba(244,63,94,.35),inset 0 -1px 0 rgba(0,0,0,.1)}',
      '.ef-btn-danger:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(244,63,94,.5),inset 0 -1px 0 rgba(0,0,0,.1)}',
      // ── Inputs ──
      '.ef-input{width:100%;padding:12px 14px;border:2px solid #e2e8f0;border-radius:10px;font-size:15px;font-family:inherit;box-sizing:border-box;margin-top:6px;transition:all .15s ease;background:#fff}',
      '.ef-input:focus{outline:none;border-color:#8b5cf6;box-shadow:0 0 0 4px rgba(139,92,246,.15)}',
      '.ef-input::placeholder{color:#94a3b8}',
      '.ef-label{display:block;font-weight:700;font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:.8px}',
      // ── Tier cards with icon chip + per-tier hover theme ──
      '.ef-tier-grid{display:grid;grid-template-columns:1fr;gap:10px}',
      '.ef-tier{padding:14px 16px;border:2px solid #e2e8f0;border-radius:14px;cursor:pointer;text-align:left;background:#fff;transition:all .2s ease;font-family:inherit;display:flex;align-items:center;gap:14px;position:relative;overflow:hidden}',
      '.ef-tier:hover{transform:translateY(-2px);box-shadow:0 12px 28px rgba(0,0,0,.08)}',
      '.ef-tier-crm:hover{border-color:#06b6d4;background:linear-gradient(135deg,#ecfeff 0%,#eff6ff 100%)}',
      '.ef-tier-tech:hover{border-color:#f97316;background:linear-gradient(135deg,#fff7ed 0%,#fef3c7 100%)}',
      '.ef-tier-client:hover{border-color:#8b5cf6;background:linear-gradient(135deg,#faf5ff 0%,#fdf4ff 100%)}',
      '.ef-tier-icon{flex-shrink:0;width:44px;height:44px;border-radius:11px;display:flex;align-items:center;justify-content:center;font-size:24px;transition:transform .2s ease}',
      '.ef-tier:hover .ef-tier-icon{transform:scale(1.1) rotate(-5deg)}',
      '.ef-tier-crm .ef-tier-icon{background:linear-gradient(135deg,#a5f3fc,#bfdbfe)}',
      '.ef-tier-tech .ef-tier-icon{background:linear-gradient(135deg,#fed7aa,#fef3c7)}',
      '.ef-tier-client .ef-tier-icon{background:linear-gradient(135deg,#e9d5ff,#fbcfe8)}',
      '.ef-tier-text{flex:1;min-width:0}',
      '.ef-tier-title{font-weight:800;font-size:14px;color:#0f172a;margin-bottom:2px;letter-spacing:-.1px}',
      '.ef-tier-desc{font-size:12px;color:#64748b}',
      '.ef-tier-chev{color:#cbd5e1;font-size:18px;transition:transform .2s ease,color .2s ease}',
      '.ef-tier:hover .ef-tier-chev{color:#6366f1;transform:translateX(3px)}',
      // ── Banners ──
      '.ef-error{background:linear-gradient(135deg,#fef2f2,#fff1f2);border:1.5px solid #fecaca;color:#991b1b;padding:11px 14px;border-radius:10px;margin-bottom:14px;font-size:13px;white-space:pre-wrap;word-break:break-word;display:flex;align-items:flex-start;gap:8px}',
      '.ef-error::before{content:"⚠️";flex-shrink:0}',
      '.ef-success{background:linear-gradient(135deg,#f0fdf4,#ecfdf5);border:1.5px solid #bbf7d0;color:#166534;padding:11px 14px;border-radius:10px;margin-bottom:14px;font-size:13px;display:flex;align-items:flex-start;gap:8px}',
      '.ef-success::before{content:"✨";flex-shrink:0}',
      // ── Big success checkmark ──
      '.ef-check-circle{width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,#10b981 0%,#06b6d4 100%);display:flex;align-items:center;justify-content:center;margin:8px auto 18px;font-size:38px;color:#fff;box-shadow:0 10px 28px rgba(16,185,129,.45),inset 0 -3px 0 rgba(0,0,0,.1);animation:efPopIn .45s cubic-bezier(.34,1.56,.64,1)}',
      '.ef-success-title{text-align:center;font-size:22px;font-weight:800;color:#0f172a;letter-spacing:-.3px;margin-bottom:6px}',
      '.ef-success-sub{text-align:center;font-size:13px;color:#64748b;margin-bottom:18px}',
      // ── Key/value grid ──
      '.ef-kv{display:grid;grid-template-columns:110px 1fr;gap:8px 14px;font-size:13px;margin-top:10px;padding:14px;background:linear-gradient(135deg,#f8fafc,#f1f5f9);border-radius:10px;border:1px solid #e2e8f0}',
      '.ef-kv b{color:#64748b;font-weight:700;text-transform:uppercase;font-size:10px;letter-spacing:.6px;align-self:center}',
      '.ef-kv span{color:#0f172a;word-break:break-all;font-weight:500}',
      // ── JWT block with color-coded parts ──
      '.ef-token-block{background:linear-gradient(135deg,#0f172a,#1e293b);padding:14px;border-radius:10px;font-family:Menlo,Consolas,monospace;font-size:11px;line-height:1.6;white-space:pre-wrap;word-break:break-all;max-height:220px;overflow:auto;margin-top:8px;border:1px solid rgba(255,255,255,.05)}',
      '.ef-jwt-header{color:#fb7185;font-weight:600}',
      '.ef-jwt-payload{color:#34d399;font-weight:600}',
      '.ef-jwt-signature{color:#60a5fa;font-weight:600}',
      '.ef-jwt-dot{color:#64748b;margin:0 2px}',
      '.ef-jwt-legend{display:flex;gap:14px;margin-top:8px;font-size:11px;color:#64748b}',
      '.ef-jwt-legend span{display:inline-flex;align-items:center;gap:5px}',
      '.ef-jwt-swatch{width:10px;height:10px;border-radius:3px;display:inline-block}',
      // ── Scheme cards in Token Inspector ──
      '.ef-scheme-card{border:1.5px solid #e2e8f0;border-radius:14px;padding:16px;margin-bottom:14px;background:linear-gradient(135deg,#fff 0%,#fafbfc 100%);transition:box-shadow .15s ease}',
      '.ef-scheme-card:hover{box-shadow:0 8px 20px rgba(0,0,0,.06)}',
      '.ef-scheme-card h4{margin:0 0 10px 0;font-size:14px;color:#0f172a;display:flex;align-items:center;gap:10px;font-weight:800;letter-spacing:-.1px}',
      // ── Animated pills ──
      '.ef-pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:999px;font-size:11px;font-weight:700;background:linear-gradient(135deg,#dcfce7,#d1fae5);color:#166534;letter-spacing:.3px;text-transform:uppercase}',
      '.ef-pill-warn{background:linear-gradient(135deg,#fef3c7,#fde68a);color:#854d0e}',
      '.ef-pill-dot{width:6px;height:6px;border-radius:50%;background:currentColor;animation:efPulseDot 1.6s ease-in-out infinite}',
      '@keyframes efPulseDot{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.4;transform:scale(1.4)}}',
      // ── Empty state ──
      '.ef-empty{text-align:center;padding:36px 0;color:#94a3b8}',
      '.ef-empty-icon{font-size:48px;margin-bottom:10px;display:block;animation:efBob 3s ease-in-out infinite}',
      '@keyframes efBob{0%,100%{transform:translateY(0)}50%{transform:translateY(-6px)}}',
      // ── Confirm dialog body text ──
      '.ef-confirm-text{font-size:14px;color:#334155;line-height:1.6}',
      // ── Copy button hover ──
      '.ef-copy-row{display:flex;justify-content:flex-end;margin-top:10px}',
      // ── Keyframes ──
      '@keyframes efFadeIn{from{opacity:0}to{opacity:1}}',
      '@keyframes efBounceIn{0%{transform:scale(.85) translateY(20px);opacity:0}100%{transform:scale(1) translateY(0);opacity:1}}',
      '@keyframes efPopIn{0%{transform:scale(0) rotate(-180deg);opacity:0}60%{transform:scale(1.15) rotate(0);opacity:1}100%{transform:scale(1) rotate(0)}}',
    ].join('');
    document.head.appendChild(s);
  }

  // ── Body scroll lock ──────────────────────────────────────────────
  // Without this the page scrolls BEHIND an open modal: the backdrop covers
  // the viewport but does not absorb wheel events, so the pointer's scroll
  // falls through to <body>. Reading position is then lost on close.
  //
  // Saved-value guard, not a bare 'auto' reset: openModal() calls closeModal()
  // first, and modal-to-modal transitions would otherwise clobber whatever
  // overflow the page actually had.
  var EF_SCROLL_LOCK = null;

  function lockScroll() {
    if (EF_SCROLL_LOCK !== null) return;
    EF_SCROLL_LOCK = document.body.style.overflow || '';
    document.body.style.overflow = 'hidden';
  }

  function unlockScroll() {
    if (EF_SCROLL_LOCK === null) return;
    document.body.style.overflow = EF_SCROLL_LOCK;
    EF_SCROLL_LOCK = null;
  }

  // ── Modal scaffold (reusable for all three flows) ─────────────────
  function openModal(title) {
    closeModal();
    var backdrop = document.createElement('div');
    backdrop.className = 'ef-backdrop';
    backdrop.id = 'ef-modal-backdrop';

    var card = document.createElement('div');
    card.className = 'ef-card';

    var head = document.createElement('div');
    head.className = 'ef-head';
    var h3 = document.createElement('h3');
    h3.textContent = title;
    var x = document.createElement('button');
    x.className = 'ef-close';
    x.type = 'button';
    x.textContent = '✕';
    x.onclick = closeModal;
    head.appendChild(h3);
    head.appendChild(x);

    var body = document.createElement('div');
    body.className = 'ef-body';

    var foot = document.createElement('div');
    foot.className = 'ef-foot';

    card.appendChild(head);
    card.appendChild(body);
    card.appendChild(foot);
    backdrop.appendChild(card);

    // Click outside the card to close.
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) closeModal();
    });

    // Escape to close — listener is rebound per open so it doesn't leak.
    var escHandler = function (e) {
      if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', escHandler); }
    };
    document.addEventListener('keydown', escHandler);

    document.body.appendChild(backdrop);
    lockScroll();
    return {
      backdrop: backdrop,
      body: body,
      foot: foot,
      setTitle: function (t) { h3.textContent = t; },
    };
  }

  function closeModal() {
    var existing = document.getElementById('ef-modal-backdrop');
    if (existing) existing.remove();
    unlockScroll();
  }

  function el(tag, props, kids) {
    var e = document.createElement(tag);
    if (props) for (var k in props) {
      if (k === 'className')   e.className = props[k];
      else if (k === 'textContent') e.textContent = props[k];
      else if (k === 'onclick')     e.onclick = props[k];
      else if (k === 'onkeydown')   e.onkeydown = props[k];
      else if (k === 'style')       e.style.cssText = props[k];
      else                          e.setAttribute(k, props[k]);
    }
    if (kids) for (var i = 0; i < kids.length; i++) e.appendChild(kids[i]);
    return e;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function showErr(box, msg) { box.textContent = msg; box.style.display = 'block'; }

  // ── Environment ───────────────────────────────────────────────────
  // Quick Login used to hardcode window.location.origin, so it could only ever
  // log in to the environment whose docs you happened to be reading. The list
  // comes from the spec's own servers block, so it can never drift from
  // docs/openapi.yaml.
  var EF_ENV_LS_KEY = 'ef-swagger-env';

  function envs() {
    try {
      var list = window.ui.specSelectors.servers().toJS();
      if (list && list.length) {
        return list.map(function (x) {
          return { url: x.url, label: x.description || x.url };
        });
      }
    } catch (e) {}
    return [{ url: window.location.origin + '/api', label: 'Current runtime' }];
  }

  function selectedEnv() {
    var list = envs();
    var saved = null;
    try { saved = window.localStorage.getItem(EF_ENV_LS_KEY); } catch (e) {}
    for (var i = 0; i < list.length; i++) if (list[i].url === saved) return list[i];
    return list[0];
  }

  // Selecting an environment also drives Swagger UI's OWN server <select>, so
  // "Try it out" lands where Quick Login just authenticated. Swagger exposes no
  // public setter for the selected server, hence the DOM route.
  function syncSwaggerServer(url) {
    var sel = document.querySelector('.swagger-ui .servers select');
    if (!sel) return false;
    for (var i = 0; i < sel.options.length; i++) {
      if (sel.options[i].value === url) {
        if (sel.selectedIndex !== i) {
          sel.selectedIndex = i;
          sel.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return true;
      }
    }
    return false;
  }

  function setEnv(url) {
    try { window.localStorage.setItem(EF_ENV_LS_KEY, url); } catch (e) {}
    syncSwaggerServer(url);
  }

  function isCrossOrigin(url) {
    try { return new URL(url, window.location.href).origin !== window.location.origin; }
    catch (e) { return false; }
  }

  // ── HTTP helpers ──────────────────────────────────────────────────
  function base() { return selectedEnv().url; }

  // Read body as text first, then try JSON.parse. Preserves raw text on
  // parse failure (e.g. Nginx HTML error pages) so it can be surfaced in
  // the error banner.
  async function readBody(res) {
    var raw = '';
    try { raw = await res.text(); } catch (e) {}
    if (!raw) return { json: {}, text: '' };
    try { return { json: JSON.parse(raw) || {}, text: raw }; }
    catch (e) { return { json: {}, text: raw }; }
  }

  function errSnippet(body, fallback) {
    if (body.json && body.json.error) return String(body.json.error);
    if (body.text) {
      var s = body.text.replace(/<[^>]+>/g, '').replace(/\\s+/g, ' ').trim();
      if (s.length > 200) s = s.slice(0, 200) + '…';
      if (s) return s;
    }
    return fallback || 'unknown';
  }

  // ── Quick Login (3-step state machine inside one modal) ───────────
  function startQuickLogin() {
    var m = openModal('🔑 Quick Login');
    stepSelectTier(m);
  }

  function stepSelectTier(m) {
    m.setTitle('🔑 Quick Login · Select Tier');
    clear(m.body); clear(m.foot);

    // ── Environment ──
    // First thing on the screen, because it decides where the OTP is sent AND
    // where every subsequent "Try it out" goes. Picking a tier first and the
    // environment second is how you end up logged into the wrong one.
    m.body.appendChild(el('div', { className: 'ef-label', textContent: 'Environment' }));
    var envRow = el('div', { className: 'ef-env-row' });
    var envList = envs();
    var cur = selectedEnv();
    var xorigin = el('div', { className: 'ef-note', style: 'display:none' });

    envList.forEach(function (env) {
      var on = env.url === cur.url;
      var b = el('button', { className: 'ef-env-chip' + (on ? ' on' : ''), type: 'button' });
      b.appendChild(el('span', { className: 'ef-env-name', textContent: env.label }));
      b.appendChild(el('span', { className: 'ef-env-url', textContent: env.url }));
      b.onclick = function () {
        setEnv(env.url);
        Array.prototype.slice.call(envRow.children).forEach(function (c) { c.className = 'ef-env-chip'; });
        b.className = 'ef-env-chip on';
        showXOrigin(env.url);
      };
      envRow.appendChild(b);
    });
    m.body.appendChild(envRow);

    function showXOrigin(url) {
      if (!isCrossOrigin(url)) { xorigin.style.display = 'none'; return; }
      xorigin.style.display = 'block';
      xorigin.textContent = 'Cross-origin: this page is served from '
        + window.location.origin + ', so login and Try-it-out both need that '
        + 'origin in the target environment\\'s CORS allowlist. A browser-only '
        + 'failure with no server log is what a missing entry looks like.';
    }
    showXOrigin(cur.url);
    m.body.appendChild(xorigin);

    m.body.appendChild(el('div', { className: 'ef-label', style: 'margin-top:18px', textContent: 'Credential' }));
    m.body.appendChild(el('div', { style: 'margin-bottom:14px;font-size:13px;color:#64748b',
      textContent: 'Choose which tier you\\'re logging in as. The token auto-fills the matching scheme — there is no separate Authorize step.' }));

    var grid = el('div', { className: 'ef-tier-grid' });
    [
      { scheme: 'bearerAdmin',  cls: 'ef-tier-crm',    icon: '🏢', title: 'CRM Admin',  desc: 'Staff users — POST /api/auth/login-otp' },
      { scheme: 'bearerTech',   cls: 'ef-tier-tech',   icon: '🔧', title: 'Technician', desc: 'Mobile app — POST /api/mobile/auth/login-otp' },
      { scheme: 'bearerClient', cls: 'ef-tier-client', icon: '👤', title: 'Client SPOC',desc: 'Dashboard — POST /api/client/auth/login-otp' },
      // The fourth credential the API accepts. It lived only behind the
      // built-in Authorize dialog, which meant the one scheme with no OTP flow
      // was also the one hidden in a different menu.
      { scheme: 'basicIntegration', cls: 'ef-tier-basic', icon: '🔐', title: 'Integration (Basic)', desc: 'Partner clients — HTTP Basic on /v1/*', basic: true },
    ].forEach(function (t) {
      var btn = el('button', { className: 'ef-tier ' + t.cls, type: 'button',
        onclick: function () { t.basic ? stepBasicAuth(m) : stepEnterIdentifier(m, t.scheme); } });
      btn.appendChild(el('div', { className: 'ef-tier-icon', textContent: t.icon }));
      var text = el('div', { className: 'ef-tier-text' });
      text.appendChild(el('div', { className: 'ef-tier-title', textContent: t.title }));
      text.appendChild(el('div', { className: 'ef-tier-desc',  textContent: t.desc  }));
      btn.appendChild(text);
      btn.appendChild(el('div', { className: 'ef-tier-chev', textContent: '›' }));
      grid.appendChild(btn);
    });
    m.body.appendChild(grid);

    m.foot.appendChild(el('button', { className: 'ef-btn ef-btn-ghost', type: 'button', textContent: 'Cancel', onclick: closeModal }));
  }

  function stepEnterIdentifier(m, scheme) {
    var t = TIERS[scheme];
    m.setTitle('🔑 Quick Login · ' + t.label);
    clear(m.body); clear(m.foot);

    var errBox = el('div', { className: 'ef-error', style: 'display:none' });
    m.body.appendChild(errBox);

    var lbl = el('label', { className: 'ef-label', textContent: t.accepts });
    var inputOpts = { className: 'ef-input', type: 'text',
      placeholder: t.placeholder,
      onkeydown: function (e) { if (e.key === 'Enter') doSend(); } };
    // Tech tier is mobile-only — surface numeric keyboard on mobile devices
    if (t.identifierField === 'mobile') {
      inputOpts.inputmode = 'numeric';
      inputOpts.maxlength = '10';
    }
    var input = el('input', inputOpts);
    lbl.appendChild(input);
    m.body.appendChild(lbl);

    var send = el('button', { className: 'ef-btn ef-btn-primary', type: 'button', textContent: 'Send OTP', onclick: doSend });
    m.foot.appendChild(el('button', { className: 'ef-btn ef-btn-ghost', type: 'button', textContent: '← Back', onclick: function () { stepSelectTier(m); } }));
    m.foot.appendChild(send);

    setTimeout(function () { input.focus(); }, 50);

    async function doSend() {
      var v = (input.value || '').trim();
      if (!v) { showErr(errBox, 'Please enter ' + t.accepts.toLowerCase() + '.'); return; }
      // Pre-validate tech mobile so we fail fast with a friendly message
      // instead of getting a Joi 400 from the BE.
      if (t.identifierField === 'mobile' && !/^[0-9]{10}$/.test(v)) {
        showErr(errBox, 'Technician login requires exactly 10 digits — no spaces, no country code.');
        return;
      }
      send.disabled = true; send.textContent = 'Sending…';
      try {
        // Build the body with the tier's expected key name. Computed
        // property keys are ES6+ — using assignment for ES5 friendliness
        // since this string is eval'd by the swagger-ui bundle.
        var body = {};
        body[t.identifierField] = v;

        var r = await fetch(base() + t.prefix + '/login-otp', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        var b = await readBody(r);
        if (!r.ok || b.json.success === false) {
          showErr(errBox, 'login-otp failed (' + r.status + '): ' + errSnippet(b));
          send.disabled = false; send.textContent = 'Send OTP';
          return;
        }
        stepEnterOtp(m, scheme, v);
      } catch (err) {
        showErr(errBox, 'Network error: ' + (err.message || err));
        send.disabled = false; send.textContent = 'Send OTP';
      }
    }
  }

  function stepEnterOtp(m, scheme, identifier) {
    var t = TIERS[scheme];
    m.setTitle('🔑 Quick Login · Enter OTP');
    clear(m.body); clear(m.foot);

    var sentBanner = el('div', { className: 'ef-success',
      textContent: 'OTP sent to ' + identifier + '. Check your email/SMS — or in dev, grep BE logs for "OTP for ' + identifier + '".' });
    m.body.appendChild(sentBanner);

    var errBox = el('div', { className: 'ef-error', style: 'display:none' });
    m.body.appendChild(errBox);

    var lbl = el('label', { className: 'ef-label', textContent: '4-digit OTP' });
    var input = el('input', { className: 'ef-input', type: 'text', inputmode: 'numeric', maxlength: '6',
      placeholder: '1234',
      onkeydown: function (e) { if (e.key === 'Enter') doVerify(); } });
    lbl.appendChild(input);
    m.body.appendChild(lbl);

    // Inline "Resend OTP" link below the input. Re-hits login-otp with the
    // same identifier — overwrites otp_details row with a fresh code. The
    // OLD code in your inbox becomes invalid immediately; only the latest
    // resend is verifiable. Useful when:
    //   - 5-minute TTL elapsed
    //   - multiple resend clicks happened and you lost track of the latest
    //   - dev mode and you missed the first BE log line
    var resendRow = el('div', { style: 'margin-top:10px;font-size:13px;color:#64748b' });
    resendRow.appendChild(document.createTextNode('Didn\\'t receive it? '));
    var resendLink = el('button', { type: 'button',
      style: 'background:none;border:none;color:#6366f1;font-weight:700;cursor:pointer;padding:0;font-size:13px;text-decoration:underline;font-family:inherit' });
    resendLink.textContent = 'Resend OTP';
    resendLink.onclick = doResend;
    resendRow.appendChild(resendLink);
    m.body.appendChild(resendRow);

    var verify = el('button', { className: 'ef-btn ef-btn-primary', type: 'button', textContent: 'Verify & Login', onclick: doVerify });
    m.foot.appendChild(el('button', { className: 'ef-btn ef-btn-ghost', type: 'button', textContent: '← Back', onclick: function () { stepEnterIdentifier(m, scheme); } }));
    m.foot.appendChild(verify);

    setTimeout(function () { input.focus(); }, 50);

    async function doResend() {
      resendLink.disabled = true;
      resendLink.textContent = 'Sending…';
      errBox.style.display = 'none';
      try {
        var body = {};
        body[t.identifierField] = identifier;
        var r = await fetch(base() + t.prefix + '/login-otp', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        var b = await readBody(r);
        if (!r.ok || b.json.success === false) {
          showErr(errBox, 'resend failed (' + r.status + '): ' + errSnippet(b));
          resendLink.disabled = false; resendLink.textContent = 'Resend OTP';
          return;
        }
        // Refresh the green banner so the user knows the previous code is now stale.
        sentBanner.textContent = 'Fresh OTP sent to ' + identifier + '. The previous code is no longer valid.';
        input.value = '';
        input.focus();
        resendLink.textContent = 'Resend OTP';
        resendLink.disabled = false;
      } catch (err) {
        showErr(errBox, 'Network error: ' + (err.message || err));
        resendLink.disabled = false; resendLink.textContent = 'Resend OTP';
      }
    }

    async function doVerify() {
      var otp = (input.value || '').trim();
      if (!otp) { showErr(errBox, 'Please enter the OTP.'); return; }
      verify.disabled = true; verify.textContent = 'Verifying…';
      try {
        // Same tier-aware body construction as login-otp — Tech expects
        // 'mobile', CRM and Client expect 'identifier'.
        var body = { otp: Number(otp) };
        body[t.identifierField] = identifier;

        var r = await fetch(base() + t.prefix + '/verify-otp', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        var b = await readBody(r);
        var token = b.json && b.json.data && b.json.data.token;
        if (!r.ok || !token) {
          showErr(errBox, 'verify-otp failed (' + r.status + '): ' + errSnippet(b, 'no token returned'));
          verify.disabled = false; verify.textContent = 'Verify & Login';
          return;
        }
        window.ui.preauthorizeApiKey(scheme, token);
        var u = (b.json.data && b.json.data.user) || {};
        stepSuccess(m, scheme, token, u, identifier);
      } catch (err) {
        showErr(errBox, 'Network error: ' + (err.message || err));
        verify.disabled = false; verify.textContent = 'Verify & Login';
      }
    }
  }

  // ── Basic Integration (no OTP — a stored username/password pair) ──
  function stepBasicAuth(m) {
    m.setTitle('🔐 Quick Login · Integration (Basic)');
    clear(m.body); clear(m.foot);

    m.body.appendChild(el('div', { className: 'ef-note', textContent:
      'HTTP Basic, /integration/v1/* only. These are PARTNER credentials, not a '
      + 'CRM login — no staff account works here. Responses use the legacy '
      + '{status: "200", message, data} envelope.' }));

    m.body.appendChild(el('div', { className: 'ef-label', style: 'margin-top:16px', textContent: 'Username' }));
    var u = el('input', { className: 'ef-input', type: 'text', autocomplete: 'off', placeholder: 'partner login name' });
    m.body.appendChild(u);

    m.body.appendChild(el('div', { className: 'ef-label', style: 'margin-top:12px', textContent: 'Password' }));
    var pw = el('input', { className: 'ef-input', type: 'password', autocomplete: 'off', placeholder: '••••••••' });
    m.body.appendChild(pw);

    var errBox = el('div', { className: 'ef-error', style: 'display:none;margin-top:14px' });
    m.body.appendChild(errBox);

    function apply() {
      var user = (u.value || '').trim();
      var pass = pw.value || '';
      if (!user || !pass) { showErr(errBox, 'Both username and password are required.'); return; }
      try {
        // preauthorizeBasic writes the same store the Authorize dialog did, so
        // "Try it out" picks it up identically. There is no verify endpoint to
        // call first — Basic is checked per-request, so the first real call is
        // what proves the credential.
        window.ui.preauthorizeBasic('basicIntegration', user, pass);
      } catch (e) {
        showErr(errBox, 'Could not apply credentials: ' + (e.message || e));
        return;
      }
      m.setTitle('🎉 Ready');
      clear(m.body); clear(m.foot);
      m.body.appendChild(el('div', { className: 'ef-check-circle', textContent: '✓' }));
      m.body.appendChild(el('div', { className: 'ef-success-title', textContent: 'Basic credentials applied' }));
      m.body.appendChild(el('div', { className: 'ef-success-sub', textContent:
        'Every /integration/v1/* call will now send Authorization: Basic for "' + user + '". '
        + 'Nothing has validated them yet — the first request will.' }));
      m.foot.appendChild(el('button', { className: 'ef-btn ef-btn-ghost', type: 'button', textContent: '‹ Back', onclick: function () { stepSelectTier(m); } }));
      m.foot.appendChild(el('button', { className: 'ef-btn ef-btn-primary', type: 'button', textContent: 'Start Exploring →', onclick: closeModal }));
    }

    pw.onkeydown = function (e) { if (e.key === 'Enter') apply(); };
    m.foot.appendChild(el('button', { className: 'ef-btn ef-btn-ghost', type: 'button', textContent: '‹ Back', onclick: function () { stepSelectTier(m); } }));
    m.foot.appendChild(el('button', { className: 'ef-btn ef-btn-primary', type: 'button', textContent: 'Apply', onclick: apply }));
    setTimeout(function () { u.focus(); }, 60);
  }

  function stepSuccess(m, scheme, token, user, identifier) {
    m.setTitle('🎉 Welcome!');
    clear(m.body); clear(m.foot);

    m.body.appendChild(el('div', { className: 'ef-check-circle', textContent: '✓' }));
    m.body.appendChild(el('div', { className: 'ef-success-title',
      textContent: 'You\\'re logged in!' }));
    m.body.appendChild(el('div', { className: 'ef-success-sub',
      textContent: 'Token persisted — every "Try it out" will auto-send Authorization: Bearer ' + token.slice(0, 12) + '…' }));

    var kv = el('div', { className: 'ef-kv' });
    [
      ['User',      user.user_name || user.official_email || identifier],
      ['Tier',      TIERS[scheme].label],
      ['Scheme',    scheme],
      ['Role ID',   user.user_role != null ? String(user.user_role) : '—'],
      ['Token TTL', '30 days (env JWT_EXPIRY)'],
    ].forEach(function (p) {
      kv.appendChild(el('b',    { textContent: p[0] }));
      kv.appendChild(el('span', { textContent: p[1] }));
    });
    m.body.appendChild(kv);

    m.foot.appendChild(el('button', { className: 'ef-btn ef-btn-primary', type: 'button', textContent: 'Start Exploring →', onclick: closeModal }));
  }

  // ── Logout (confirm modal) ────────────────────────────────────────
  function startLogout() {
    var m = openModal('🚪 See you later!');
    m.body.appendChild(el('div', { className: 'ef-confirm-text', textContent:
      'This will clear ALL Bearer tokens (admin / tech / client) and the Basic-Integration credentials from this Swagger session. You\\'ll need to log in again to call protected endpoints.' }));

    var errBox = el('div', { className: 'ef-error', style: 'display:none;margin-top:14px' });
    m.body.appendChild(errBox);

    m.foot.appendChild(el('button', { className: 'ef-btn ef-btn-ghost', type: 'button', textContent: 'Cancel', onclick: closeModal }));
    m.foot.appendChild(el('button', { className: 'ef-btn ef-btn-danger', type: 'button', textContent: 'Logout', onclick: function () {
      try {
        if (window.ui && window.ui.authActions && typeof window.ui.authActions.logout === 'function') {
          window.ui.authActions.logout(SCHEMES);
        }
        try { window.localStorage.removeItem('authorized'); } catch (e) {}
        closeModal();
        // Back to the Token modal, which now shows its empty state — the
        // clearing is visible as a result rather than asserted in a toast.
        startShowToken();
      } catch (err) {
        showErr(errBox, 'Logout error: ' + (err.message || err));
      }
    } }));
  }

  // ── Token Inspector ───────────────────────────────────────────────

  // base64url → JSON. Robust against URL-safe alphabet (- / _) AND
  // missing padding, AND UTF-8 in the payload (rare, but valid).
  function decodeJwtPayload(token) {
    try {
      var parts = String(token).split('.');
      if (parts.length !== 3) return null;
      var p = parts[1].replace(/-/g, '+').replace(/_/g, '/');
      while (p.length % 4) p += '=';
      var decoded = atob(p);
      try {
        decoded = decodeURIComponent(decoded.split('').map(function (c) {
          return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
      } catch (e) {}
      return JSON.parse(decoded);
    } catch (e) { return null; }
  }

  function formatExp(exp) {
    if (!exp) return '—';
    var d = new Date(exp * 1000);
    var diffMs = d.getTime() - Date.now();
    var human;
    if (diffMs <= 0) human = '⚠ expired';
    else {
      var hrs = Math.floor(diffMs / 3600000);
      var days = Math.floor(hrs / 24);
      human = days > 0 ? days + 'd ' + (hrs % 24) + 'h remaining' : hrs + 'h remaining';
    }
    return d.toLocaleString() + ' · ' + human;
  }

  function getCurrentAuth() {
    // Prefer localStorage because that's the persisted source of truth
    // when persistAuthorization is on. Fall back to swagger-ui's in-
    // memory state for the edge case where the user toggled persistence
    // off but still has an in-memory auth.
    try {
      var raw = window.localStorage.getItem('authorized');
      if (raw) return JSON.parse(raw) || {};
    } catch (e) {}
    try { return window.ui.authSelectors.authorized().toJS() || {}; }
    catch (e) { return {}; }
  }

  // Colour-code the three JWT segments so the visual structure (header.payload.signature)
  // is immediately obvious. Returns a <div> with three coloured <span>s + dot separators.
  function colorizeJwt(token) {
    var wrapper = document.createElement('div');
    var parts = String(token).split('.');
    if (parts.length !== 3) {
      wrapper.textContent = token;
      return wrapper;
    }
    wrapper.appendChild(el('span', { className: 'ef-jwt-header',    textContent: parts[0] }));
    wrapper.appendChild(el('span', { className: 'ef-jwt-dot',       textContent: '.' }));
    wrapper.appendChild(el('span', { className: 'ef-jwt-payload',   textContent: parts[1] }));
    wrapper.appendChild(el('span', { className: 'ef-jwt-dot',       textContent: '.' }));
    wrapper.appendChild(el('span', { className: 'ef-jwt-signature', textContent: parts[2] }));
    return wrapper;
  }

  function jwtLegend() {
    var l = el('div', { className: 'ef-jwt-legend' });
    [
      ['#fb7185', 'Header'],
      ['#34d399', 'Payload'],
      ['#60a5fa', 'Signature'],
    ].forEach(function (pair) {
      var item = el('span');
      item.appendChild(el('span', { className: 'ef-jwt-swatch', style: 'background:' + pair[0] }));
      item.appendChild(document.createTextNode(pair[1]));
      l.appendChild(item);
    });
    return l;
  }

  function pillWithDot(label, warn) {
    var p = el('span', { className: warn ? 'ef-pill ef-pill-warn' : 'ef-pill' });
    p.appendChild(el('span', { className: 'ef-pill-dot' }));
    p.appendChild(document.createTextNode(label));
    return p;
  }

  function startShowToken() {
    var m = openModal('📋 Active Tokens');

    var auth = getCurrentAuth();
    var present = BEARER_SCHEMES.filter(function (s) { return auth && auth[s] && auth[s].value; });

    if (present.length === 0) {
      var empty = el('div', { className: 'ef-empty' });
      empty.appendChild(el('span', { className: 'ef-empty-icon', textContent: '🔭' }));
      empty.appendChild(el('div', { style: 'font-size:15px;font-weight:600;color:#475569;margin-bottom:4px', textContent: 'No tokens in orbit yet' }));
      empty.appendChild(el('div', { style: 'font-size:13px', textContent: 'Click "🔑 Quick Login" up top to grab one.' }));
      m.body.appendChild(empty);
    } else {
      present.forEach(function (scheme) {
        var entry = auth[scheme];
        var token = entry.value;
        var payload = decodeJwtPayload(token);

        var card = el('div', { className: 'ef-scheme-card' });
        var head = el('h4');
        head.appendChild(document.createTextNode(scheme));
        var expired = payload && payload.exp && (payload.exp * 1000 < Date.now());
        head.appendChild(pillWithDot(expired ? 'expired' : 'active', expired));
        card.appendChild(head);

        if (payload) {
          var kv = el('div', { className: 'ef-kv' });
          [
            ['sub',   payload.sub || '—'],
            ['email', payload.email || '—'],
            ['role',  payload.role != null ? String(payload.role) : '—'],
            ['name',  payload.name || '—'],
            ['iat',   payload.iat ? new Date(payload.iat * 1000).toLocaleString() : '—'],
            ['exp',   formatExp(payload.exp)],
          ].forEach(function (p) {
            kv.appendChild(el('b',    { textContent: p[0] }));
            kv.appendChild(el('span', { textContent: p[1] }));
          });
          card.appendChild(kv);
        } else {
          card.appendChild(el('div', { className: 'ef-error', textContent: 'Could not decode payload — not a valid JWT.' }));
        }

        card.appendChild(el('div', { className: 'ef-label', textContent: 'Raw JWT', style: 'margin-top:14px' }));
        var block = el('div', { className: 'ef-token-block' });
        block.appendChild(colorizeJwt(token));
        card.appendChild(block);
        card.appendChild(jwtLegend());

        var copyRow = el('div', { className: 'ef-copy-row' });
        var copyBtn = el('button', { className: 'ef-btn ef-btn-ghost', type: 'button', textContent: '📋 Copy' });
        copyBtn.onclick = function () {
          var done = function () { copyBtn.textContent = '✓ Copied!'; setTimeout(function () { copyBtn.textContent = '📋 Copy'; }, 1300); };
          var fail = function () { copyBtn.textContent = '✕ Copy failed'; };
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(token).then(done).catch(fail);
            } else {
              var ta = document.createElement('textarea');
              ta.value = token; document.body.appendChild(ta);
              ta.select(); document.execCommand('copy'); ta.remove();
              done();
            }
          } catch (e) { fail(); }
        };
        copyRow.appendChild(copyBtn);

        // Clear THIS scheme only. The reason Logout moved in here: it clears
        // everything, and "everything" is rarely what you want when three
        // tiers are live and one has expired.
        var rmBtn = el('button', { className: 'ef-btn ef-btn-ghost ef-btn-danger-ghost', type: 'button', textContent: '✕ Remove' });
        rmBtn.onclick = function () {
          try {
            window.ui.authActions.logout([scheme]);
            startShowToken();
          } catch (e) {
            card.appendChild(el('div', { className: 'ef-error', textContent: 'Could not clear ' + scheme + ': ' + (e.message || e) }));
          }
        };
        copyRow.appendChild(rmBtn);
        card.appendChild(copyRow);

        m.body.appendChild(card);
      });
    }

    // Basic is a credential too, and it was invisible here while it lived
    // behind the Authorize dialog. Username shown, password never.
    var basic = auth && auth.basicIntegration && auth.basicIntegration.value;
    if (basic) {
      var bcard = el('div', { className: 'ef-scheme-card' });
      var bhead = el('h4');
      bhead.appendChild(document.createTextNode('basicIntegration'));
      bhead.appendChild(pillWithDot('active', false));
      bcard.appendChild(bhead);
      var bkv = el('div', { className: 'ef-kv' });
      bkv.appendChild(el('b', { textContent: 'username' }));
      bkv.appendChild(el('span', { textContent: basic.username || '—' }));
      bkv.appendChild(el('b', { textContent: 'password' }));
      bkv.appendChild(el('span', { textContent: '•••••••• (never displayed)' }));
      bkv.appendChild(el('b', { textContent: 'scope' }));
      bkv.appendChild(el('span', { textContent: '/integration/v1/* only' }));
      bcard.appendChild(bkv);
      var brow = el('div', { className: 'ef-copy-row' });
      var brm = el('button', { className: 'ef-btn ef-btn-ghost ef-btn-danger-ghost', type: 'button', textContent: '✕ Remove' });
      brm.onclick = function () {
        try { window.ui.authActions.logout(['basicIntegration']); startShowToken(); } catch (e) {}
      };
      brow.appendChild(brm);
      bcard.appendChild(brow);
      m.body.appendChild(bcard);
    }

    var anyCred = present.length > 0 || !!basic;

    if (anyCred) {
      m.foot.appendChild(el('button', { className: 'ef-btn ef-btn-danger', type: 'button', textContent: '🚪 Clear all', onclick: startLogout }));
    }
    m.foot.appendChild(el('button', { className: 'ef-btn ef-btn-primary', type: 'button', textContent: 'Close', onclick: closeModal }));
  }

  // ── Pinned-button cluster ─────────────────────────────────────────
  // The cluster uses CSS classes (ef-cta + ef-cta-{login|token|logout}) for the
  // gradient backgrounds + hover lift + login-button glow pulse. The fixed
  // right-offsets are kept as inline style so the cluster stays right-anchored
  // without a containing flex parent.
  function makeBtn(opts) {
    var b = document.createElement('button');
    b.id = opts.id;
    b.type = 'button';
    b.title = opts.title;
    b.className = 'ef-cta ' + opts.variant;
    b.style.right = opts.right + 'px';
    b.textContent = opts.text;
    b.onclick = opts.onClick;
    return b;
  }

  // ── JWT tier content (JS-owned, sanitiser-proof) ──
  // Last-turn iteration buried the per-tier content in markdown HTML and
  // relied on swagger-ui's renderer preserving classes / data attributes.
  // It doesn\'t — the sanitiser strips them inconsistently.
  // New strategy: the YAML ships only a TEXT MARKER ("EF::JWT_TABS_MOUNT_POINT::").
  // After render, JS finds that text node, replaces its parent element with
  // a fully DOM-constructed tab UI sourced from the JWT_TIERS data below.
  // Zero dependency on attribute preservation.
  var JWT_TIERS = [
    {
      key: 'crm',
      label: '🏢 CRM Admin',
      introHtml: 'Signed by <code>utils/jwt.js::signUserToken()</code> on the verify-otp endpoint at <code>/api/auth/*</code>.<br>Login accepts <strong>EITHER email OR mobile</strong> as <code>identifier</code> — both resolve to the same <code>tbl_user</code> row, and the JWT <strong>always</strong> carries the canonical <code>official_email</code> regardless of which one the user typed.',
      code: [
        'jwt.sign(',
        '  {',
        '    sub:   String(user.user_id),       // string user_id',
        '    email: user.official_email,        // always populated from tbl_user',
        '    role:  user.user_role,             // numeric role_id',
        '    name:  user.user_name,',
        '  },',
        '  process.env.JWT_SECRET,',
        "  { expiresIn: process.env.JWT_EXPIRY || '30d' }",
        ');',
      ].join('\\n'),
      verifyHtml: '<strong>Verification path:</strong> <code>middleware/auth.js</code> → <code>utils/jwt.js::verifyToken()</code> → looks up <code>tbl_user</code> by <code>decoded.sub</code> → stamps <code>req.user</code> with the freshest row.',
    },
    {
      key: 'tech',
      label: '🔧 Technician',
      introHtml: 'Signed by <code>tech-auth.service.js</code> on the verify-otp endpoint at <code>/api/mobile/*</code>.<br>Login is <strong>mobile-only</strong> — there\\'s no email path. JWT carries <code>mobile</code>, NOT <code>email</code>. The <code>efr:</code> prefix on <code>sub</code> disambiguates a technician id from a CRM user id without an extra DB call.',
      code: [
        'jwt.sign(',
        '  {',
        '    sub:    \`efr:\${tech.efr_id}\`,      // "efr:" prefix disambiguates from user_id',
        '    name:   tech.efr_name,',
        '    mobile: tech.efr_no,               // technician\\'s 10-digit mobile',
        '  },',
        '  process.env.JWT_SECRET,',
        "  { expiresIn: process.env.JWT_EXPIRY || '30d' }",
        ');',
      ].join('\\n'),
      verifyHtml: '<strong>Verification path:</strong> <code>middleware/tech-auth.js</code> → checks the <code>efr:</code> prefix → looks up <code>tbl_easyfixer</code> by efr_id → stamps <code>req.tech</code>.',
    },
    {
      key: 'client',
      label: '👤 Client SPOC',
      introHtml: 'Signed by <code>client-auth.service.js</code> on the verify-otp endpoint at <code>/api/client/*</code>.<br>Login is <strong>email-only</strong> (or 10-digit mobile resolving to a SPOC contact). JWT carries <code>email</code> + <code>clientId</code>. The <code>clientId</code> claim auto-scopes every subsequent query to this SPOC\\'s client without separate join logic.',
      code: [
        'jwt.sign(',
        '  {',
        '    sub:      \`spoc:\${spoc.id}\`,        // "spoc:" prefix',
        '    clientId: spoc.client_id,           // which client this SPOC belongs to',
        '    name:     spoc.contact_name,',
        '    email:    spoc.contact_email,',
        '  },',
        '  process.env.JWT_SECRET,',
        "  { expiresIn: process.env.JWT_EXPIRY || '30d' }",
        ');',
      ].join('\\n'),
      verifyHtml: '<strong>Verification path:</strong> <code>middleware/client-auth.js</code> → checks the <code>spoc:</code> prefix → looks up <code>tbl_client_contacts</code> → stamps <code>req.spoc</code> + <code>req.clientId</code>.',
    },
  ];

  // Per-tier comparison table (same JS-built approach for sanitiser
  // resilience). Cells are inline-HTML strings; the builder uses innerHTML
  // for cell content — safe because the content is hardcoded in this file,
  // not user-supplied.
  var JWT_COMPARISON = {
    header: ['Tier', 'Login Identifier', 'JWT Carries', 'JWT Does NOT Carry', 'sub Prefix'],
    rows: [
      [
        '<strong>CRM Admin</strong> <code>bearerAdmin</code>',
        'email OR mobile (either works)',
        '<code>sub</code>, <code>email</code>, <code>role</code>, <code>name</code>',
        '<code>mobile</code>',
        '(none — bare user_id as string)',
      ],
      [
        '<strong>Technician</strong> <code>bearerTech</code>',
        'mobile only',
        '<code>sub</code>, <code>mobile</code>, <code>name</code>',
        '<code>email</code>, <code>role</code>',
        '<code>efr:&lt;efr_id&gt;</code>',
      ],
      [
        '<strong>Client SPOC</strong> <code>bearerClient</code>',
        'email only',
        '<code>sub</code>, <code>email</code>, <code>clientId</code>, <code>name</code>',
        '<code>mobile</code>, <code>role</code>',
        '<code>spoc:&lt;contact_id&gt;</code>',
      ],
    ],
  };

  // ── Marker-finding helper ─────────────────────────────────────────
  // TreeWalker walks every text node under .info. We compare textContent
  // for an exact marker substring. Returns the FIRST matching node, or null.
  // Cheaper + more reliable than parsing the entire DOM tree manually.
  function findMarkerNode(infoEl, marker) {
    if (!infoEl) return null;
    var walker = document.createTreeWalker(infoEl, NodeFilter.SHOW_TEXT, null);
    var n;
    while ((n = walker.nextNode())) {
      if (n.textContent.indexOf(marker) !== -1) return n;
    }
    return null;
  }

  // localStorage key for the selected tier — persists across reloads.
  var EF_JWT_TAB_LS_KEY = 'ef-swagger-jwt-tab';

  function buildJwtTabs() {
    var container = document.createElement('div');
    container.className = 'ef-jwt-tabs';

    var bar = document.createElement('div');
    bar.className = 'ef-jwt-tabbar';
    container.appendChild(bar);

    var panelWrap = document.createElement('div');
    panelWrap.className = 'ef-jwt-panel-wrap';
    container.appendChild(panelWrap);

    // Restore last-selected tab from localStorage, default to first tier.
    var savedKey;
    try { savedKey = window.localStorage.getItem(EF_JWT_TAB_LS_KEY); } catch (e) {}
    var startIdx = 0;
    if (savedKey) {
      for (var j = 0; j < JWT_TIERS.length; j++) {
        if (JWT_TIERS[j].key === savedKey) { startIdx = j; break; }
      }
    }

    var btns = [];
    var panels = [];

    JWT_TIERS.forEach(function (tier, i) {
      // Tab button
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ef-jwt-tab' + (i === startIdx ? ' ef-jwt-tab-active' : '');
      btn.setAttribute('data-jwt-tab', tier.key);
      btn.textContent = tier.label;
      bar.appendChild(btn);
      btns.push(btn);

      // Panel
      var panel = document.createElement('div');
      panel.className = 'ef-jwt-panel' + (i === startIdx ? ' ef-jwt-panel-active' : '');
      panel.setAttribute('data-jwt-panel', tier.key);

      var intro = document.createElement('p');
      intro.innerHTML = tier.introHtml;
      panel.appendChild(intro);

      var pre = document.createElement('pre');
      var code = document.createElement('code');
      code.textContent = tier.code;
      pre.appendChild(code);
      panel.appendChild(pre);

      var verify = document.createElement('p');
      verify.innerHTML = tier.verifyHtml;
      panel.appendChild(verify);

      panelWrap.appendChild(panel);
      panels.push(panel);
    });

    // Wire click handlers
    btns.forEach(function (btn, i) {
      btn.onclick = function () {
        btns.forEach(function (b) { b.classList.remove('ef-jwt-tab-active'); });
        panels.forEach(function (p) { p.classList.remove('ef-jwt-panel-active'); });
        btn.classList.add('ef-jwt-tab-active');
        panels[i].classList.add('ef-jwt-panel-active');
        try { window.localStorage.setItem(EF_JWT_TAB_LS_KEY, JWT_TIERS[i].key); } catch (e) {}
      };
    });

    return container;
  }

  function buildJwtComparison() {
    var wrapper = document.createElement('div');
    wrapper.className = 'ef-jwt-comparison-wrap';
    var table = document.createElement('table');
    table.className = 'ef-jwt-comparison';
    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    JWT_COMPARISON.header.forEach(function (h) {
      var th = document.createElement('th');
      th.textContent = h;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    JWT_COMPARISON.rows.forEach(function (rowData, rowIdx) {
      var tr = document.createElement('tr');
      tr.setAttribute('data-tier-row', JWT_TIERS[rowIdx] ? JWT_TIERS[rowIdx].key : '');
      rowData.forEach(function (cellHtml) {
        var td = document.createElement('td');
        td.innerHTML = cellHtml;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrapper.appendChild(table);
    return wrapper;
  }

  // ── Mount helpers ─────────────────────────────────────────────────
  // Find the marker text node, replace its parent (usually a <p>) with the
  // JS-built UI. Idempotent — checks data-ef-jwt-mounted attribute on the
  // parent so re-renders do not double-mount.
  function mountAtMarker(infoEl, marker, buildFn, mountFlag) {
    var markerNode = findMarkerNode(infoEl, marker);
    if (!markerNode) return false;
    var host = markerNode.parentElement;
    if (!host) return false;
    if (host.getAttribute(mountFlag) === '1') return true; // already mounted
    var built = buildFn();
    host.parentNode.replaceChild(built, host);
    built.setAttribute(mountFlag, '1');
    return true;
  }

  function initJwtTabs() {
    var info = document.querySelector('.swagger-ui .info');
    return mountAtMarker(info, 'EF::JWT_TABS_MOUNT_POINT::', buildJwtTabs, 'data-ef-jwt-mounted');
  }

  function initJwtComparison() {
    var info = document.querySelector('.swagger-ui .info');
    return mountAtMarker(info, 'EF::JWT_COMPARISON_MOUNT_POINT::', buildJwtComparison, 'data-ef-jwt-cmp-mounted');
  }

  function tryInitJwtTabs(retries) {
    var ok1 = initJwtTabs();
    var ok2 = initJwtComparison();
    if (ok1 && ok2) return;
    if (retries <= 0) return;
    setTimeout(function () { tryInitJwtTabs(retries - 1); }, 300);
  }

  // ── MutationObserver — re-mount if Swagger UI re-renders the description ──
  // Server-dropdown switch, locale change, or any internal state update can
  // cause swagger-ui to re-render the .info block. When that happens, our
  // injected DOM is wiped. The observer watches childList mutations on
  // .swagger-ui and re-runs mount if our markers reappear.
  function watchInfoRerenders() {
    var root = document.querySelector('.swagger-ui');
    if (!root || root.getAttribute('data-ef-jwt-watching') === '1') return;
    root.setAttribute('data-ef-jwt-watching', '1');
    var observer = new MutationObserver(function () {
      var info = document.querySelector('.swagger-ui .info');
      if (!info) return;
      // Re-mount only if a marker is back in the DOM (i.e., a re-render happened).
      if (findMarkerNode(info, 'EF::JWT_TABS_MOUNT_POINT::')) initJwtTabs();
      if (findMarkerNode(info, 'EF::JWT_COMPARISON_MOUNT_POINT::')) initJwtComparison();
    });
    observer.observe(root, { childList: true, subtree: true });
  }

  // ── Sidebar rail: sections + tier filter ──────────────────────────
  //
  // Both are derived from ONE source — the tag names, which openapi-autogen
  // mints as "Tier - Section" (see inferTag). So a new route group appears in
  // the rail and in the filter without either being edited.
  var EF_TIER_LS_KEY = 'ef-swagger-tiers';
  var EF_RAIL_ID = 'ef-rail';

  // The declared taxonomy, in the order openapi.yaml lists it. Tag inference
  // is per-path and produces junk tiers for one-off routes ("Openapi.json",
  // "Book"), so anything not declared is folded into Other rather than
  // becoming its own filter chip.
  var EF_TIERS = ['Auth', 'Admin', 'Mobile', 'Client', 'Shared', 'Integration'];

  function tierOf(tag) {
    var i = tag.indexOf(' — ');
    var t = i === -1 ? tag : tag.slice(0, i);
    return EF_TIERS.indexOf(t) === -1 ? 'Other' : t;
  }

  function sectionOf(tag) {
    var i = tag.indexOf(' — ');
    return i === -1 ? tag : tag.slice(i + 3);
  }

  // Live from the DOM rather than the spec: these are the groups Swagger UI
  // actually rendered, so the rail can never list a section that isn't there.
  function tagNodes() {
    return Array.prototype.slice.call(
      document.querySelectorAll('.swagger-ui .opblock-tag'));
  }

  function tagNameOf(node) {
    return (node.getAttribute('data-tag') || node.textContent || '').trim();
  }

  function hiddenTiers() {
    try {
      var raw = window.localStorage.getItem(EF_TIER_LS_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  }

  function setHiddenTiers(list) {
    try { window.localStorage.setItem(EF_TIER_LS_KEY, JSON.stringify(list)); } catch (e) {}
    applyTierFilter();
  }

  // Hides the whole group: the tag header AND the operations under it. Swagger
  // UI keeps them as siblings, not children, so both have to be walked.
  function applyTierFilter() {
    var hidden = hiddenTiers();
    tagNodes().forEach(function (node) {
      var off = hidden.indexOf(tierOf(tagNameOf(node))) !== -1;
      node.style.display = off ? 'none' : '';
      var sib = node.nextElementSibling;
      while (sib && !sib.classList.contains('opblock-tag')) {
        sib.style.display = off ? 'none' : '';
        sib = sib.nextElementSibling;
      }
    });
    var rail = document.getElementById(EF_RAIL_ID);
    if (rail) {
      Array.prototype.slice.call(rail.querySelectorAll('[data-ef-tier]')).forEach(function (a) {
        a.style.display = hidden.indexOf(a.getAttribute('data-ef-tier')) !== -1 ? 'none' : '';
      });
      Array.prototype.slice.call(rail.querySelectorAll('[data-ef-grp]')).forEach(function (g) {
        g.style.display = hidden.indexOf(g.getAttribute('data-ef-grp')) !== -1 ? 'none' : '';
      });
    }
  }

  // Offset for the fixed button cluster; scrollIntoView has no way to express
  // one, so the scroll is computed rather than delegated.
  var EF_SCROLL_OFFSET = 84;

  function scrollToTag(node) {
    var y = Math.max(0, node.getBoundingClientRect().top + window.scrollY - EF_SCROLL_OFFSET);
    /*
     * Two-argument scrollTo, NOT scrollTo({top, behavior:'smooth'}).
     *
     * Measured on this page: the options form with behavior:'smooth' is a
     * silent no-op — it returns normally, throws nothing, and leaves scrollY
     * at 0, while scrollTo(0, y) moves to the identical computed offset. The
     * rail links looked dead with no error anywhere.
     *
     * Smoothness comes from CSS scroll-behavior on <html> instead, which the
     * same browser honours. Presentation in CSS, the movement in JS.
     */
    window.scrollTo(0, y);
  }

  /*
   * Scroll, then correct twice.
   *
   * One pass is not enough: swagger-ui renders operation rows lazily, so the
   * act of scrolling 40,000px changes the height of everything above the
   * target and the heading ends up hundreds — sometimes tens of thousands —
   * of pixels from where it was aimed. Measured: a single pass landed
   * "Mobile — Jobs" 57,225px off.
   *
   * Each pass re-measures from the CURRENT layout, so the error shrinks to
   * nothing. Two corrections were enough for every group on this page; the
   * final one is a cheap no-op when the first already landed.
   */
  function scrollToTagSettled(node) {
    scrollToTag(node);
    setTimeout(function () { scrollToTag(node); }, 80);
    setTimeout(function () { scrollToTag(node); }, 260);
  }

  function buildRail() {
    var nodes = tagNodes();
    if (!nodes.length) return false;

    var existing = document.getElementById(EF_RAIL_ID);
    if (existing) existing.remove();

    var rail = el('nav', { id: EF_RAIL_ID, className: 'ef-rail' });

    // ── Tier filter ──
    var seen = [];
    nodes.forEach(function (n) {
      var t = tierOf(tagNameOf(n));
      if (t && seen.indexOf(t) === -1) seen.push(t);
    });
    var tiers = EF_TIERS.filter(function (t) { return seen.indexOf(t) !== -1; });
    if (seen.indexOf('Other') !== -1) tiers.push('Other');

    var hidden = hiddenTiers();
    rail.appendChild(el('div', { className: 'ef-rail-grp', textContent: 'Tier' }));
    var filter = el('div', { className: 'ef-rail-filter' });
    tiers.forEach(function (t) {
      var on = hidden.indexOf(t) === -1;
      var chip = el('button', { className: 'ef-tier-chip' + (on ? ' on' : ''), type: 'button', textContent: t });
      chip.onclick = function () {
        var h = hiddenTiers();
        var i = h.indexOf(t);
        if (i === -1) h.push(t); else h.splice(i, 1);
        setHiddenTiers(h);
        chip.className = 'ef-tier-chip' + (h.indexOf(t) === -1 ? ' on' : '');
      };
      filter.appendChild(chip);
    });
    rail.appendChild(filter);

    var all = el('button', { className: 'ef-rail-all', type: 'button', textContent: 'Show all tiers' });
    all.onclick = function () { setHiddenTiers([]); buildRail(); };
    rail.appendChild(all);

    // ── Sections, grouped by tier ──
    // Sorted by tier so each heading appears once. Swagger renders tags
    // alphabetically, which interleaves tiers and would repeat every heading.
    nodes = nodes.slice().sort(function (a, b) {
      var ta = tiers.indexOf(tierOf(tagNameOf(a)));
      var tb = tiers.indexOf(tierOf(tagNameOf(b)));
      if (ta !== tb) return ta - tb;
      return tagNameOf(a).localeCompare(tagNameOf(b));
    });

    var lastTier = null;
    nodes.forEach(function (n) {
      var tag = tagNameOf(n);
      var tier = tierOf(tag);
      if (tier !== lastTier) {
        rail.appendChild(el('div', { className: 'ef-rail-grp', 'data-ef-grp': tier, textContent: tier }));
        lastTier = tier;
      }
      var a = el('a', { className: 'ef-rail-link', 'data-ef-tier': tier, 'data-ef-tag': tag, textContent: sectionOf(tag) });
      a.href = '#';
      a.onclick = function (e) {
        e.preventDefault();
        /*
         * Re-resolve the target by TAG NAME at click time.
         *
         * Holding the node captured during build looks equivalent and is not:
         * Swagger UI re-renders the operation list on expand, filter and
         * server change, replacing every .opblock-tag element. The captured
         * node is then detached, and scrollIntoView on a detached node is a
         * silent no-op — the link appears dead with no error anywhere.
         */
        var target = null;
        tagNodes().some(function (cand) {
          if (tagNameOf(cand) === tag) { target = cand; return true; }
          return false;
        });
        if (!target) return;

        // Open a collapsed group BEFORE scrolling: expanding grows the page
        // above the target and would leave the scroll short by that much.
        if (target.getAttribute('data-is-open') === 'false') {
          target.click();
          setTimeout(function () { scrollToTagSettled(target); }, 120);
        } else {
          scrollToTagSettled(target);
        }
      };
      rail.appendChild(a);
    });

    document.body.appendChild(rail);
    applyTierFilter();
    return true;
  }

  // Swagger UI re-renders the operation list on filter/expand, which drops the
  // rail's targets. Rebuild on mutation, debounced so a burst costs one pass.
  function watchRail() {
    var root = document.querySelector('#swagger-ui') || document.body;
    var t = null;
    new MutationObserver(function () {
      clearTimeout(t);
      t = setTimeout(function () {
        var rail = document.getElementById(EF_RAIL_ID);
        var n = tagNodes().length;
        if (!n) return;
        if (!rail || rail.querySelectorAll('.ef-rail-link').length !== n) buildRail();
        else applyTierFilter();
      }, 250);
    }).observe(root, { childList: true, subtree: true });
  }

  function tryBuildRail(retries) {
    if (buildRail()) { watchRail(); return; }
    if (retries > 0) setTimeout(function () { tryBuildRail(retries - 1); }, 400);
  }

  // ── Masthead wordmark ─────────────────────────────────────────────
  // The same base64 asset docs/CLIENT_API_INTEGRATION.html uses, so the
  // Partner guide and this reference read as one product.
  //
  // The artwork is cyan + WHITE on transparency (drawn for the CRM's dark
  // sidebar), so on this light ground the white half would vanish. It gets an
  // ink plaque, exactly as the Partner guide does — a CSS filter would darken
  // the white and drag the cyan off-brand at the same time.
  var EF_WORDMARK = 'data:image/png;base64,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';

  function mountWordmark() {
    var title = document.querySelector('.swagger-ui .info .title');
    if (!title || title.querySelector('.ef-wordmark')) return false;
    var img = document.createElement('img');
    img.className = 'ef-wordmark';
    img.src = EF_WORDMARK;
    img.alt = 'EasyFix';
    // Replaces the word "EasyFix" in the heading so it reads as one lockup:
    // [EasyFix] Backend API. alt keeps the heading a sentence for screen
    // readers, which a decorative logo beside the text would not.
    var walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT, null);
    var node;
    while ((node = walker.nextNode())) {
      var i = node.nodeValue.indexOf('EasyFix');
      if (i === -1) continue;
      var after = node.splitText(i);
      after.nodeValue = after.nodeValue.slice('EasyFix'.length);
      node.parentNode.insertBefore(img, after);
      return true;
    }
    title.insertBefore(img, title.firstChild);
    return true;
  }

  function tryMountWordmark(retries) {
    if (mountWordmark()) return;
    if (retries > 0) setTimeout(function () { tryMountWordmark(retries - 1); }, 300);
  }

  function ready() {
    if (!window.ui || typeof window.ui.preauthorizeApiKey !== 'function') {
      return setTimeout(ready, 300);
    }
    if (document.getElementById('ef-quick-login-btn')) return;

    injectStyles();

    // Two buttons, not three. Logout moved INTO the Token modal: it is an
    // operation on tokens, it belongs beside the tokens it clears, and the
    // Token modal is the only place that can offer clearing one at a time.
    document.body.appendChild(makeBtn({ id: 'ef-quick-login-btn',  text: '🔑 Quick Login', title: 'Pick an environment and tier, then authenticate', variant: 'ef-cta-login',  right: 156, onClick: startQuickLogin }));
    document.body.appendChild(makeBtn({ id: 'ef-show-token-btn',   text: '📋 Token',       title: 'Inspect, clear one, or clear every credential',   variant: 'ef-cta-token',  right: 24,  onClick: startShowToken  }));

    // Kick off the JWT-tab + comparison-table mount + observer for
    // re-render survival. Self-bails out cleanly if markers absent.
    tryInitJwtTabs(15);
    watchInfoRerenders();
    tryBuildRail(20);
    tryMountWordmark(15);

    // Delegated, not per-element: swagger-ui re-renders operation rows
    // constantly, and a bound handler would need rebinding on every mutation.
    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest && e.target.closest('.authorization__btn');
      if (!btn) return;
      e.preventDefault();
      e.stopPropagation();
      startQuickLogin();
    }, true);
    // Re-apply the saved environment on load so the server selector and
    // Quick Login agree before anyone touches either.
    setTimeout(function () { syncSwaggerServer(selectedEnv().url); }, 600);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ready);
  } else {
    ready();
  }
}());
`;

/*
 * Custom Swagger UI theme. Overrides swagger-ui's default rendering of:
 *   - body background (soft slate gradient)
 *   - info / description card (white container with gradient top accent)
 *   - title (gradient-text logo treatment)
 *   - markdown headers / tables / inline code / pre blocks
 *   - server selector + auth bar (lifted card)
 *   - operation tag headers (rounded card heads)
 *   - operation blocks (rounded with soft shadow)
 *   - the built-in Authorize button (mint-green outlined)
 *
 * All overrides use `.swagger-ui …` selectors to win against the bundle's
 * default styles without resorting to `!important` except where the bundle
 * itself uses `!important` (the markdown code blocks do).
 */
const SWAGGER_THEME_CSS = [
  // ── Page chrome ──
  'body{background:linear-gradient(180deg,#f1f5f9 0%,#e0e7ff 50%,#fdf2f8 100%) fixed!important;min-height:100vh}',
  '.swagger-ui{background:transparent}',
  '.swagger-ui .topbar{display:none}',
  '.swagger-ui .wrapper{max-width:1240px;padding:0 24px}',
  // Spacer so the pinned cluster (Quick Login / Token / Logout) doesn\'t collide with the title
  '.swagger-ui section.swagger-container,.swagger-ui .swagger-ui{padding-top:72px}',

  // ── Hero card: info + description ──
  '.swagger-ui .information-container{background:transparent;padding:0;margin-bottom:24px}',
  '.swagger-ui .info{margin:0;padding:38px 44px;background:#fff;border-radius:22px;box-shadow:0 14px 44px rgba(15,23,42,.08),0 0 0 1px rgba(255,255,255,.6);position:relative;overflow:hidden}',
  '.swagger-ui .info::before{content:"";position:absolute;top:0;left:0;right:0;height:6px;background:linear-gradient(90deg,#06b6d4 0%,#3b82f6 25%,#6366f1 50%,#8b5cf6 75%,#ec4899 100%)}',
  '.swagger-ui .info::after{content:"";position:absolute;top:-50%;right:-10%;width:50%;height:200%;background:radial-gradient(circle,rgba(139,92,246,.05) 0%,transparent 60%);pointer-events:none}',

  // ── Title — gradient text ──
  '.swagger-ui .info hgroup.main{margin:0 0 18px 0}',
  '.swagger-ui .info .title{font-size:34px!important;font-weight:800!important;letter-spacing:-.7px!important;line-height:1.15!important;background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 50%,#ec4899 100%);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;color:transparent;margin:0}',
  '.swagger-ui .info .title small{display:none}',
  '.swagger-ui .info .title small.version-stamp{display:inline-block;background:linear-gradient(135deg,#dbeafe,#ede9fe);color:#4338ca;padding:4px 10px;border-radius:999px;font-size:11px;font-weight:700;margin-left:12px;-webkit-text-fill-color:#4338ca;letter-spacing:.5px;text-transform:uppercase}',

  // ── Description body ──
  '.swagger-ui .info .description,.swagger-ui .info .markdown,.swagger-ui .info .renderedMarkdown{font-size:14px;line-height:1.65;color:#334155}',
  '.swagger-ui .info p{color:#475569;margin:8px 0 14px}',
  // Markdown H3 headers → big section dividers
  '.swagger-ui .info h3,.swagger-ui .info .markdown h3,.swagger-ui .info .renderedMarkdown h3{font-size:20px!important;font-weight:800!important;color:#0f172a!important;letter-spacing:-.3px;margin:32px 0 14px;padding:0 0 10px;border-bottom:2px solid;border-image:linear-gradient(90deg,#a5b4fc,#f9a8d4,transparent) 1;line-height:1.3}',
  // Markdown bold
  '.swagger-ui .info strong{color:#0f172a;font-weight:700}',

  // ── Inline code — subtle indigo pill ──
  '.swagger-ui .info code,.swagger-ui .info .renderedMarkdown code,.swagger-ui .info .markdown code{background:#eef2ff!important;color:#4338ca!important;padding:2px 7px!important;border-radius:5px!important;font-family:"SF Mono",Menlo,Consolas,monospace!important;font-size:12.5px!important;border:1px solid #e0e7ff!important;font-weight:500}',

  // ── Code blocks (pre) — dark theme ──
  '.swagger-ui .info pre,.swagger-ui .info .renderedMarkdown pre,.swagger-ui .info .markdown pre{background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%)!important;color:#e2e8f0!important;padding:18px 22px!important;border-radius:12px!important;border:1px solid rgba(99,102,241,.15)!important;box-shadow:0 6px 20px rgba(15,23,42,.18)!important;overflow-x:auto;font-size:12.5px!important;line-height:1.6!important;margin:14px 0!important;position:relative}',
  '.swagger-ui .info pre code,.swagger-ui .info .renderedMarkdown pre code,.swagger-ui .info .markdown pre code{background:transparent!important;color:#e2e8f0!important;border:none!important;padding:0!important;font-size:inherit!important;font-family:"SF Mono",Menlo,Consolas,monospace!important;font-weight:400}',

  // ── Tables in markdown ──
  '.swagger-ui .info table,.swagger-ui .info .renderedMarkdown table,.swagger-ui .info .markdown table{border-collapse:separate;border-spacing:0;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;margin:18px 0;width:100%;box-shadow:0 2px 8px rgba(0,0,0,.03)}',
  '.swagger-ui .info table th{background:linear-gradient(135deg,#f8fafc,#eef2ff)!important;color:#475569!important;font-weight:700!important;font-size:11px!important;text-transform:uppercase;letter-spacing:.6px;padding:12px 16px!important;text-align:left!important;border-bottom:1px solid #e2e8f0!important}',
  '.swagger-ui .info table td{padding:11px 16px!important;border-bottom:1px solid #f1f5f9!important;font-size:13px!important;color:#1e293b!important;line-height:1.5}',
  '.swagger-ui .info table tr:last-child td{border-bottom:none!important}',
  '.swagger-ui .info table tr:nth-child(even) td{background:#fafbfc!important}',
  '.swagger-ui .info table tr:hover td{background:#f0f9ff!important;transition:background .15s}',

  // ── Lists ──
  '.swagger-ui .info ul,.swagger-ui .info .markdown ul,.swagger-ui .info .renderedMarkdown ul{padding-left:22px;margin:10px 0 14px}',
  '.swagger-ui .info ul li,.swagger-ui .info .markdown ul li,.swagger-ui .info .renderedMarkdown ul li{margin:6px 0;color:#334155}',
  '.swagger-ui .info ol{padding-left:22px;margin:10px 0 14px}',
  '.swagger-ui .info ol li{margin:6px 0;color:#334155}',

  // ── Links ──
  '.swagger-ui .info a{color:#6366f1;font-weight:600;text-decoration:none;border-bottom:1px dotted #a5b4fc;transition:color .15s,border-color .15s}',
  '.swagger-ui .info a:hover{color:#ec4899;border-bottom-color:#f9a8d4}',

  // ── Server selector + Authorize bar ──
  '.swagger-ui .scheme-container{background:#fff!important;border-radius:16px!important;box-shadow:0 6px 22px rgba(15,23,42,.06)!important;margin:0 0 22px 0!important;padding:20px 26px!important;border:1px solid rgba(255,255,255,.6)}',
  '.swagger-ui .scheme-container .schemes-title{font-weight:800;color:#0f172a;font-size:13px;text-transform:uppercase;letter-spacing:.6px}',
  '.swagger-ui .servers>label{font-weight:700;color:#475569;font-size:11px;text-transform:uppercase;letter-spacing:.6px}',
  '.swagger-ui .servers>label select{margin-top:6px;padding:9px 12px;border:2px solid #e2e8f0;border-radius:9px;font-size:13px;font-weight:600;color:#0f172a;background:#fff;cursor:pointer;transition:border-color .15s}',
  '.swagger-ui .servers>label select:hover{border-color:#a5b4fc}',
  '.swagger-ui .servers>label select:focus{outline:none;border-color:#6366f1;box-shadow:0 0 0 3px rgba(99,102,241,.15)}',

  // ── Built-in Authorize button — mint outline ──
  '.swagger-ui .btn.authorize{background:#fff!important;border:2px solid #10b981!important;color:#10b981!important;border-radius:9px!important;font-weight:700!important;padding:8px 16px!important;letter-spacing:.2px;transition:all .15s ease;box-shadow:0 2px 8px rgba(16,185,129,.12)}',
  '.swagger-ui .btn.authorize:hover{background:linear-gradient(135deg,#f0fdf4,#ecfdf5)!important;transform:translateY(-1px);box-shadow:0 6px 16px rgba(16,185,129,.25)!important}',
  '.swagger-ui .btn.authorize svg{fill:#10b981!important}',
  '.swagger-ui .btn.authorize.locked{background:linear-gradient(135deg,#10b981,#059669)!important;color:#fff!important;border-color:transparent!important}',
  '.swagger-ui .btn.authorize.locked svg{fill:#fff!important}',

  // ── Tag (group) headers ──
  '.swagger-ui .opblock-tag{background:#fff!important;border-radius:14px!important;padding:18px 24px!important;margin:18px 0 0 0!important;border:1px solid rgba(0,0,0,.05)!important;box-shadow:0 4px 14px rgba(15,23,42,.04)!important;font-size:18px!important;font-weight:800!important;letter-spacing:-.2px;color:#0f172a!important;transition:box-shadow .15s ease}',
  '.swagger-ui .opblock-tag:hover{box-shadow:0 8px 22px rgba(15,23,42,.07)!important}',
  '.swagger-ui .opblock-tag small{color:#64748b!important;font-weight:500!important;font-size:13px!important}',
  '.swagger-ui .opblock-tag svg{fill:#6366f1!important}',

  // ── Operation blocks ──
  '.swagger-ui .opblock{border-radius:12px!important;margin:8px 0 10px 0!important;border:1px solid rgba(0,0,0,.06)!important;box-shadow:0 2px 8px rgba(15,23,42,.04)!important;overflow:hidden;transition:box-shadow .15s ease,transform .15s ease}',
  '.swagger-ui .opblock:hover{box-shadow:0 6px 18px rgba(15,23,42,.08)!important}',
  '.swagger-ui .opblock .opblock-summary{padding:10px 18px!important;border:none!important}',
  '.swagger-ui .opblock .opblock-summary-method{border-radius:7px!important;font-weight:800!important;letter-spacing:.6px;font-size:12px!important;min-width:72px;text-align:center;box-shadow:0 2px 6px rgba(0,0,0,.12)}',
  '.swagger-ui .opblock-summary-path{font-weight:700!important;color:#0f172a!important;font-size:14px!important}',
  '.swagger-ui .opblock-summary-description{color:#64748b!important;font-size:13px}',

  // Method colour accents (gradient backgrounds)
  '.swagger-ui .opblock.opblock-get{background:rgba(96,165,250,.04)!important;border-color:rgba(96,165,250,.25)!important}',
  '.swagger-ui .opblock.opblock-post{background:rgba(52,211,153,.04)!important;border-color:rgba(52,211,153,.25)!important}',
  '.swagger-ui .opblock.opblock-put{background:rgba(251,146,60,.04)!important;border-color:rgba(251,146,60,.25)!important}',
  '.swagger-ui .opblock.opblock-patch{background:rgba(56,189,248,.04)!important;border-color:rgba(56,189,248,.25)!important}',
  '.swagger-ui .opblock.opblock-delete{background:rgba(248,113,113,.04)!important;border-color:rgba(248,113,113,.25)!important}',

  // ── Try it out / Execute buttons ──
  '.swagger-ui .btn.try-out__btn{background:#fff!important;border:2px solid #cbd5e1!important;color:#475569!important;border-radius:8px!important;font-weight:700!important;transition:all .15s ease}',
  '.swagger-ui .btn.try-out__btn:hover{border-color:#6366f1!important;color:#4338ca!important;background:#eef2ff!important}',
  '.swagger-ui .btn.execute{background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 100%)!important;border:none!important;color:#fff!important;border-radius:9px!important;font-weight:800!important;padding:10px 22px!important;box-shadow:0 4px 12px rgba(99,102,241,.35)!important;transition:all .15s ease}',
  '.swagger-ui .btn.execute:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(99,102,241,.5)!important}',

  // ── Models / Schemas section ──
  '.swagger-ui section.models{background:#fff!important;border-radius:14px!important;box-shadow:0 4px 16px rgba(15,23,42,.05)!important;border:1px solid rgba(0,0,0,.05)!important;margin-top:24px;padding:0 4px}',
  '.swagger-ui section.models h4{color:#0f172a!important;font-weight:800!important;letter-spacing:-.2px}',

  // ── Filter / search input ──
  '.swagger-ui .filter .operation-filter-input{border:2px solid #e2e8f0!important;border-radius:10px!important;padding:10px 14px!important;font-size:13px!important;background:#fff!important;transition:all .15s ease}',
  '.swagger-ui .filter .operation-filter-input:focus{border-color:#8b5cf6!important;box-shadow:0 0 0 4px rgba(139,92,246,.12)!important;outline:none}',

  // ── Footer cleanup ──
  '.swagger-ui .info .main hgroup>a{display:none}',

  // ── JWT tier tabs (JS-built header + panels) ──
  // Markdown sanitiser strips class attributes inconsistently, so we DON'T
  // rely on CSS-only :checked tricks. The container ships from openapi.yaml
  // as three sibling panels with data-jwt-key markers; initJwtTabs() in
  // QUICK_LOGIN_JS finds them after render, inserts a tab bar at the top,
  // hides all panels except the active one, and wires real click handlers.
  // Active tier accent matches the Quick Login modal: CRM=indigo, Tech=orange, Client=violet.
  '.swagger-ui .info .ef-jwt-tabs{margin:20px 0 14px;border:1px solid #e2e8f0;border-radius:14px;overflow:hidden;background:#fff;box-shadow:0 6px 20px rgba(15,23,42,.05)}',
  '.swagger-ui .info .ef-jwt-tabbar{display:flex;background:linear-gradient(180deg,#f8fafc,#f1f5f9);border-bottom:1px solid #e2e8f0;padding:8px 8px 0 8px;gap:4px;flex-wrap:wrap}',
  '.swagger-ui .info .ef-jwt-tab{padding:11px 22px;border:none;background:transparent;cursor:pointer;font-weight:700;font-size:13px;color:#64748b;border-bottom:3px solid transparent;margin-bottom:-1px;border-radius:9px 9px 0 0;transition:all .15s ease;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif;letter-spacing:.2px;display:inline-flex;align-items:center}',
  '.swagger-ui .info .ef-jwt-tab:hover{background:rgba(99,102,241,.06);color:#0f172a}',
  // Active state — base styling (CRM/indigo default). Per-tier overrides below via data-jwt-tab attribute.
  '.swagger-ui .info .ef-jwt-tab.ef-jwt-tab-active{background:linear-gradient(180deg,#fff,#eef2ff);color:#4338ca;border-bottom-color:#6366f1}',
  '.swagger-ui .info .ef-jwt-tab.ef-jwt-tab-active[data-jwt-tab=tech]{background:linear-gradient(180deg,#fff,#fff7ed);color:#c2410c;border-bottom-color:#f97316}',
  '.swagger-ui .info .ef-jwt-tab.ef-jwt-tab-active[data-jwt-tab=client]{background:linear-gradient(180deg,#fff,#faf5ff);color:#7c3aed;border-bottom-color:#8b5cf6}',
  // Panels — hidden by default; initJwtTabs adds .ef-jwt-panel-active to one.
  '.swagger-ui .info .ef-jwt-panel{padding:22px 24px 18px;display:none}',
  '.swagger-ui .info .ef-jwt-panel.ef-jwt-panel-active{display:block;animation:efJwtFade .2s ease-out}',
  '.swagger-ui .info .ef-jwt-panel p{margin:0 0 12px 0}',
  '.swagger-ui .info .ef-jwt-panel pre{margin:14px 0!important}',
  // The label spans inside each panel — initJwtTabs reads .textContent to
  // build the tab button, then hides them so they don\'t appear as section
  // headings inside the active panel.
  '.swagger-ui .info .ef-jwt-panel-label{display:none}',
  '@keyframes efJwtFade{from{opacity:0;transform:translateY(2px)}to{opacity:1;transform:translateY(0)}}',

  // ── JWT comparison table (JS-built — same defensive pattern) ──
  '.swagger-ui .info .ef-jwt-comparison-wrap{margin:18px 0;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;box-shadow:0 4px 14px rgba(15,23,42,.04)}',
  '.swagger-ui .info .ef-jwt-comparison{width:100%;border-collapse:separate;border-spacing:0;background:#fff}',
  '.swagger-ui .info .ef-jwt-comparison thead th{background:linear-gradient(135deg,#f8fafc,#eef2ff);color:#475569;font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:.6px;padding:12px 16px;text-align:left;border-bottom:2px solid #e2e8f0;white-space:nowrap}',
  '.swagger-ui .info .ef-jwt-comparison tbody td{padding:14px 16px;border-bottom:1px solid #f1f5f9;font-size:13px;color:#1e293b;line-height:1.55;vertical-align:top}',
  '.swagger-ui .info .ef-jwt-comparison tbody tr:last-child td{border-bottom:none}',
  '.swagger-ui .info .ef-jwt-comparison tbody tr[data-tier-row=crm]    td:first-child{border-left:4px solid #6366f1}',
  '.swagger-ui .info .ef-jwt-comparison tbody tr[data-tier-row=tech]   td:first-child{border-left:4px solid #f97316}',
  '.swagger-ui .info .ef-jwt-comparison tbody tr[data-tier-row=client] td:first-child{border-left:4px solid #8b5cf6}',
  '.swagger-ui .info .ef-jwt-comparison tbody tr:hover td{background:linear-gradient(135deg,#f8fafc,#f0f9ff);transition:background .15s}',
  '.swagger-ui .info .ef-jwt-comparison strong{color:#0f172a;font-weight:800}',

  // ── Built-in Authorize modal (the one that opens when you click the green lock) ──
  // swagger-ui calls this the "dialog-ux" — its default styling is bare white-on-grey.
  // We give it the same gradient header + rounded card treatment as our custom modal,
  // and style the scheme cards / inputs / buttons inside.
  '.swagger-ui .dialog-ux{backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);background:rgba(15,23,42,.45)!important}',
  '.swagger-ui .dialog-ux .modal-ux{border-radius:18px!important;border:none!important;box-shadow:0 25px 70px rgba(0,0,0,.35),0 0 0 1px rgba(255,255,255,.06)!important;overflow:hidden;animation:efBounceIn .38s cubic-bezier(.34,1.56,.64,1);max-width:680px!important}',
  '.swagger-ui .dialog-ux .modal-ux-header{background:linear-gradient(135deg,#6366f1 0%,#8b5cf6 45%,#ec4899 100%)!important;padding:18px 24px!important;border:none!important;position:relative;overflow:hidden}',
  '.swagger-ui .dialog-ux .modal-ux-header::before{content:"";position:absolute;top:-30%;right:-10%;width:60%;height:160%;background:radial-gradient(circle,rgba(255,255,255,.25) 0%,transparent 60%);pointer-events:none}',
  '.swagger-ui .dialog-ux .modal-ux-header h3{color:#fff!important;font-size:16px!important;font-weight:700!important;letter-spacing:-.2px;margin:0;text-shadow:0 1px 2px rgba(0,0,0,.15);position:relative;z-index:1}',
  '.swagger-ui .dialog-ux .modal-ux-header .close-modal{background:rgba(255,255,255,.15)!important;border:none!important;color:#fff!important;width:30px!important;height:30px!important;border-radius:8px!important;cursor:pointer;transition:background .15s,transform .15s;position:relative;z-index:1;padding:0!important;display:flex;align-items:center;justify-content:center}',
  '.swagger-ui .dialog-ux .modal-ux-header .close-modal:hover{background:rgba(255,255,255,.28)!important;transform:rotate(90deg)}',
  '.swagger-ui .dialog-ux .modal-ux-header .close-modal svg{fill:#fff!important;width:14px;height:14px}',
  '.swagger-ui .dialog-ux .modal-ux-content{padding:24px!important;background:#fff!important;max-height:70vh}',
  '.swagger-ui .dialog-ux .modal-ux-inner{padding:0!important}',

  // Each scheme card inside the Authorize dialog (bearerAdmin, bearerTech, …)
  '.swagger-ui .auth-container{border:1.5px solid #e2e8f0!important;border-radius:14px!important;padding:18px 20px!important;margin:0 0 16px 0!important;background:linear-gradient(135deg,#fff 0%,#fafbfc 100%)!important;transition:box-shadow .15s ease}',
  '.swagger-ui .auth-container:hover{box-shadow:0 8px 20px rgba(0,0,0,.06)!important}',
  '.swagger-ui .auth-container h4{font-size:15px!important;font-weight:800!important;color:#0f172a!important;margin:0 0 10px 0!important;letter-spacing:-.1px;display:flex;align-items:center;gap:8px}',
  '.swagger-ui .auth-container h4 code{background:#eef2ff!important;color:#4338ca!important;padding:2px 8px!important;border-radius:5px!important;font-size:12px!important;font-weight:700!important;border:1px solid #e0e7ff!important}',
  '.swagger-ui .auth-container h6{font-size:11px!important;font-weight:700!important;color:#64748b!important;text-transform:uppercase;letter-spacing:.6px;margin:12px 0 4px 0}',
  '.swagger-ui .auth-container p{font-size:13px!important;color:#475569!important;line-height:1.6!important;margin:6px 0!important}',
  '.swagger-ui .auth-container .markdown p,.swagger-ui .auth-container .renderedMarkdown p{color:#475569!important;line-height:1.65}',
  '.swagger-ui .auth-container code{background:#eef2ff!important;color:#4338ca!important;padding:2px 7px!important;border-radius:5px!important;font-size:12.5px!important;border:1px solid #e0e7ff!important;font-weight:500}',
  '.swagger-ui .auth-container ul{padding-left:20px;margin:6px 0}',
  '.swagger-ui .auth-container ul li{font-size:13px;color:#475569;margin:4px 0;line-height:1.55}',

  // Inputs inside the dialog
  '.swagger-ui .auth-container input[type=text],.swagger-ui .auth-container input[type=password]{padding:11px 14px!important;border:2px solid #e2e8f0!important;border-radius:10px!important;font-size:14px!important;font-family:inherit!important;background:#fff!important;transition:all .15s ease;width:100%!important;box-sizing:border-box;margin-top:4px!important;color:#0f172a!important}',
  '.swagger-ui .auth-container input[type=text]:focus,.swagger-ui .auth-container input[type=password]:focus{outline:none;border-color:#8b5cf6!important;box-shadow:0 0 0 4px rgba(139,92,246,.15)!important}',
  '.swagger-ui .auth-container label{font-weight:700!important;font-size:11px!important;color:#64748b!important;text-transform:uppercase;letter-spacing:.6px}',

  // The Authorize/Close button row inside the dialog
  '.swagger-ui .auth-btn-wrapper{padding-top:18px!important;border-top:1px solid #e2e8f0;margin-top:18px;display:flex;justify-content:flex-end;gap:10px}',
  '.swagger-ui .auth-btn-wrapper .btn-done{background:#fff!important;color:#475569!important;border:1.5px solid #e2e8f0!important;border-radius:9px!important;padding:9px 18px!important;font-weight:700!important;transition:all .15s ease}',
  '.swagger-ui .auth-btn-wrapper .btn-done:hover{background:#f8fafc!important;border-color:#cbd5e1!important;color:#1e293b!important}',
  '.swagger-ui .auth-btn-wrapper .authorize{background:linear-gradient(135deg,#10b981 0%,#059669 100%)!important;color:#fff!important;border:none!important;border-radius:9px!important;padding:9px 20px!important;font-weight:800!important;box-shadow:0 4px 12px rgba(16,185,129,.35),inset 0 -1px 0 rgba(0,0,0,.1)!important;transition:all .15s ease}',
  '.swagger-ui .auth-btn-wrapper .authorize:hover{transform:translateY(-2px);box-shadow:0 8px 20px rgba(16,185,129,.5),inset 0 -1px 0 rgba(0,0,0,.1)!important}',
  '.swagger-ui .auth-btn-wrapper .btn-done svg,.swagger-ui .auth-btn-wrapper .authorize svg{display:none}',
  // ══ Enterprise restyle — mirrors docs/CLIENT_API_INTEGRATION.html ══
  // Same tokens as the Partner API guide so the two docs read as one product.
  ':root{--ef-ground:#FBFAF9;--ef-surface:#FFFFFF;--ef-surface-alt:#F5F1F1;--ef-ink:#1A1618;--ef-ink-muted:#6B6167;--ef-ink-faint:#938A8E;--ef-rule:#E6DEDF;--ef-accent:#C42430;--ef-accent-soft:#FBEDEE;--ef-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;--ef-mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace}',

  // Flat paper ground, not the old three-stop gradient — the reference reads
  // as a document, and a gradient behind dense tables reads as a dashboard.
  // color-scheme:light is load-bearing, not cosmetic. swagger-ui ships no dark
  // theme, so on a dark-mode browser the UA paints the root dark and renders
  // form controls and scrollbars dark while every swagger surface stays light
  // — the page comes out half-inverted. Declaring the scheme stops the UA
  // theming rather than fighting it rule by rule.
  // (The Partner guide DOES have a real dark mode; porting it here means
  // theming swagger-ui's own components, which is its own piece of work.)
  ':root{color-scheme:light}',
  // NO scroll-behavior:smooth here, deliberately. Smooth scrolling is broken
  // on this page in the same way the JS options form is: adding it made the
  // working two-argument scrollTo(0, y) route through the same dead path and
  // stop moving at all. An instant jump that lands is better than an animated
  // one that does not.

  // !important is required, not sloppy: swagger-ui 5 ships its own
  // @media(prefers-color-scheme:dark) block, and a media-query rule at equal
  // specificity wins on source order. On a dark-mode browser that block paints
  // .swagger-ui #1C2022 while every surface WE style stays paper — the page
  // renders half-inverted, which is exactly what it did before this line.
  'html{background:var(--ef-ground)!important}',
  '.swagger-ui{background:var(--ef-ground)!important}',
  '@media(prefers-color-scheme:dark){html,body,.swagger-ui{background:var(--ef-ground)!important;color:var(--ef-ink)!important}',
  '.swagger-ui .opblock,.swagger-ui .opblock-tag,.swagger-ui table,.swagger-ui .model-box{background:var(--ef-surface)!important;color:var(--ef-ink)!important}',
  '.swagger-ui .info .title,.swagger-ui .info p,.swagger-ui .info li,.swagger-ui table td,.swagger-ui table th{color:var(--ef-ink)!important}',
  '.swagger-ui .opblock-tag small,.swagger-ui .opblock-tag small p,.swagger-ui .opblock-tag>div>p,.swagger-ui .opblock-summary-description{color:var(--ef-ink-muted)!important}}',
  'body{background:var(--ef-ground)!important;font-family:var(--ef-sans)!important;color:var(--ef-ink)!important;-webkit-font-smoothing:antialiased}',
  '.swagger-ui,.swagger-ui .info,.swagger-ui .opblock-tag{font-family:var(--ef-sans)!important;color:var(--ef-ink)}',
  '.swagger-ui .info .title{letter-spacing:-.025em!important;color:var(--ef-ink)!important;background:none!important;-webkit-text-fill-color:var(--ef-ink)!important}',

  // Rail occupies the left gutter; content is pushed, not overlapped.
  '@media(min-width:1180px){.swagger-ui .wrapper{max-width:1180px!important;padding-left:264px!important}}',

  // ── Index rail ──
  // Independent scroll: own max-height + overscroll-behavior:contain, so the
  // page does not scroll when the rail reaches its end.
  '.ef-rail{position:fixed;top:96px;left:max(16px,calc(50vw - 590px));width:232px;max-height:calc(100vh - 128px);overflow-y:auto;overscroll-behavior:contain;padding-right:8px;font-size:.86rem;z-index:40;scrollbar-width:thin;scrollbar-color:var(--ef-rule) transparent}',
  '.ef-rail::-webkit-scrollbar{width:8px}',
  '.ef-rail::-webkit-scrollbar-thumb{background:var(--ef-rule);border-radius:4px}',
  '.ef-rail::-webkit-scrollbar-track{background:transparent}',
  '@media(max-width:1179px){.ef-rail{display:none}}',
  '.ef-rail-grp{font-family:var(--ef-mono);font-size:.66rem;letter-spacing:.13em;text-transform:uppercase;color:var(--ef-ink-faint);margin:20px 0 6px}',
  '.ef-rail-grp:first-child{margin-top:0}',
  '.ef-rail-link{display:block;padding:3px 10px;color:var(--ef-ink-muted);text-decoration:none;border-left:2px solid var(--ef-rule);transition:color .12s,border-color .12s;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
  '.ef-rail-link:hover{color:var(--ef-accent);border-left-color:var(--ef-accent)}',

  // ── Tier filter (multi-select) ──
  '.ef-rail-filter{display:flex;flex-wrap:wrap;gap:5px;margin-bottom:8px}',
  '.ef-tier-chip{font-family:var(--ef-sans);font-size:11px;font-weight:600;padding:3px 9px;border-radius:999px;border:1.5px solid var(--ef-rule);background:transparent;color:var(--ef-ink-faint);cursor:pointer;transition:all .12s}',
  '.ef-tier-chip:hover{border-color:var(--ef-accent);color:var(--ef-accent)}',
  '.ef-tier-chip.on{background:var(--ef-accent-soft);border-color:var(--ef-accent);color:var(--ef-accent)}',
  '.ef-rail-all{font-family:var(--ef-sans);font-size:11px;color:var(--ef-ink-faint);background:none;border:0;padding:0 0 4px;cursor:pointer;text-decoration:underline}',
  '.ef-rail-all:hover{color:var(--ef-accent)}',

  // ── Per-operation padlock ──
  // It opened the Authorize dialog, which Quick Login replaced — so it became
  // a control that did nothing when clicked. The ICON still carries real
  // information (this operation needs a credential), so it is rewired to open
  // Quick Login rather than deleted: removing it would drop the signal along
  // with the dead behaviour.
  '.swagger-ui .authorization__btn{cursor:pointer!important;opacity:.55;transition:opacity .12s}',
  '.swagger-ui .authorization__btn:hover{opacity:1}',

  // ── Built-in Authorize: removed ──
  // Everything it offered now lives in Quick Login, including Basic. Two doors
  // to one room is how a user ends up authorised in the wrong scheme.
  '.swagger-ui .auth-wrapper{display:none!important}',

  // ── Operation blocks — flatten to the reference's paper look ──
  '.swagger-ui .opblock{border-radius:10px!important;border:1px solid var(--ef-rule)!important;box-shadow:none!important;background:var(--ef-surface)!important;margin:0 0 10px!important}',
  '.swagger-ui .opblock .opblock-summary{border-color:var(--ef-rule)!important}',
  '.swagger-ui .opblock-tag{font-size:1.05rem!important;font-weight:650!important;letter-spacing:-.01em;color:var(--ef-ink)!important;border-bottom:1px solid var(--ef-rule)!important}',
  '.swagger-ui .opblock-summary-path,.swagger-ui .opblock-summary-path__deprecated{font-family:var(--ef-mono)!important;font-size:13px!important}',
  '.swagger-ui .btn.execute{background:var(--ef-accent)!important;border-color:var(--ef-accent)!important;border-radius:8px!important}',
  '.swagger-ui .btn.execute:hover{background:#A71F29!important;border-color:#A71F29!important}',
  '.swagger-ui .filter .operation-filter-input{border:1.5px solid var(--ef-rule)!important;border-radius:9px!important;font-family:var(--ef-sans)!important}',
  '.swagger-ui .filter .operation-filter-input:focus{border-color:var(--ef-accent)!important;outline:none!important}',

  // ── Masthead ──
  '.swagger-ui .info .title{display:flex;align-items:center;flex-wrap:wrap;gap:.06em .3em;font-size:clamp(2rem,4.4vw,3rem)!important;line-height:1.05!important}',
  '.ef-wordmark{height:.82em;width:auto;background:var(--ef-ink);padding:.16em .24em;border-radius:.14em;box-sizing:content-box}',
  '.swagger-ui .info .title small{display:none!important}',
  '.swagger-ui .info{margin:0 0 28px!important;padding:56px 0 36px!important;border-bottom:2px solid var(--ef-ink)!important;background:none!important;box-shadow:none!important;border-radius:0!important}',
  '.swagger-ui .info .description{color:var(--ef-ink-muted)!important}',
  // swagger-ui 5's dark block colours these #E4E6E6 — fine on its own dark
  // ground, invisible on paper. The <p> inside the tag's <small> needs naming
  // explicitly: styling .opblock-tag small alone loses to the more specific
  // rule on the paragraph it wraps.
  '.swagger-ui .opblock-tag small,.swagger-ui .opblock-tag small p,.swagger-ui .opblock-tag>div>p{color:var(--ef-ink-muted)!important}',
  '.swagger-ui .opblock-tag small code{color:var(--ef-ink)!important;background:var(--ef-surface-alt)!important}',
  '.swagger-ui .opblock .opblock-summary-description,.swagger-ui .parameter__name,.swagger-ui .parameter__type,.swagger-ui .response-col_status,.swagger-ui .response-col_description{color:var(--ef-ink-muted)!important}',
  '.swagger-ui .opblock-description-wrapper p,.swagger-ui .opblock-external-docs-wrapper p,.swagger-ui .responses-inner h4,.swagger-ui .responses-inner h5{color:var(--ef-ink)!important}',
  '.swagger-ui table thead tr th,.swagger-ui table tbody tr td{color:var(--ef-ink)!important}',
  '.swagger-ui .download-url-button{background:var(--ef-accent)!important;color:#fff!important;border-color:var(--ef-accent)!important}',
  '.swagger-ui .info hgroup.main{margin:0!important}',
  // The old hero card decorated .info with a 6px rainbow bar (::before) and a
  // violet radial wash (::after). Both belonged to the gradient treatment this
  // restyle replaced; left in place they read as artefacts on paper.
  '.swagger-ui .info::before,.swagger-ui .info::after{display:none!important;content:none!important}',
  // The separator goes on the INNER .schemes.wrapper, never on
  // .scheme-container. scheme-container is a full-bleed 100vw band sitting
  // outside .wrapper, so a border on it draws straight across the fixed rail.
  // The inner wrapper carries the same padding-left as the content column, so
  // its rule starts where the text does.
  '.swagger-ui .scheme-container{background:none!important;box-shadow:none!important;padding:0!important;border:0!important;margin-bottom:24px!important}',
  // A pseudo-element, not a border. .schemes carries .wrapper's 264px
  // padding-left, and a border draws on the BORDER box — which still begins
  // at x=0, under the rail. A block child is laid out in the CONTENT box, so
  // its rule starts exactly where the text does, at any viewport width, with
  // no second breakpoint to keep in sync.
  '.swagger-ui .scheme-container .schemes{padding-bottom:0!important;border:0!important}',
  '.swagger-ui .scheme-container .schemes::after{content:"";display:block;border-bottom:1px solid var(--ef-rule);margin-top:24px}',
].join('');

/*
 * Swagger / OpenAPI UI + spec — auto-generated from the live app.
 *
 * Surfaces (mounted in server.js):
 *
 *   GET /api/docs           — Swagger UI (interactive)
 *   GET /api/openapi.json   — Raw OpenAPI 3 spec (for codegen tools)
 *
 * How the spec is assembled:
 *
 *   1. STATIC SCAFFOLDING comes from `docs/openapi.yaml` — info, servers,
 *      tag descriptions, security-scheme definitions, reusable schemas
 *      (Job, Notice, etc.). Hand-curated so the spec has rich docs.
 *
 *   2. PATHS are generated at runtime by `openapi-autogen.js` walking
 *      `app._router.stack`. Every registered route with a Joi validator
 *      auto-appears in the docs — zero YAML maintenance. The autogen
 *      reads the `_openapi` tags on `validate()` + auth middlewares to
 *      extract request schemas + security schemes.
 *
 *   3. Build is LAZY-on-first-request — by the time someone visits
 *      /api/docs, server.js has called `init(app)` so the spec is ready.
 *      Cached after first build; rebuild only happens on server restart.
 *
 * Enable / disable: strict opt-in via SWAGGER_ENABLED=true env. Default
 * OFF in every environment (see .env.example).
 */

const SPEC_PATH = path.join(__dirname, 'openapi.yaml');

function isEnabled() {
  return String(process.env.SWAGGER_ENABLED || '').toLowerCase() === 'true';
}

// Reference to the Express app — set by init(app). Until init runs,
// the spec build returns the static scaffolding only (no paths).
let _app = null;
let _cachedSpec = null;

/*
 * Call once from server.js AFTER all routes are mounted:
 *
 *   app.use('/api', routes);
 *   require('./docs/swagger').init(app);
 *
 * Caches the app reference so the lazy spec-build can introspect
 * `app._router.stack`. We don't build the spec NOW because some routes
 * may be mounted lazily; but in practice everything's registered by the
 * end of server.js's module load, so first-request build returns the
 * full picture.
 */
function init(app) {
  _app = app;
}

function buildSpec() {
  if (_cachedSpec) return _cachedSpec;

  // 1. Load the static scaffolding (info, servers, schemas, security, tags).
  const raw = fs.readFileSync(SPEC_PATH, 'utf8');
  const spec = yaml.load(raw);

  // 2. REPLACE the hand-written paths with auto-derived ones. The YAML's
  //    paths section becomes irrelevant — everything comes from the
  //    live router stack. Hand-curated paths used to be here; they're
  //    deleted to make the autogen the only source of truth.
  spec.paths = _app ? buildOpenApiPaths(_app) : {};

  // 3. Patch `servers` so "Try it out" hits the current runtime.
  const runtimeBase = process.env.SWAGGER_PUBLIC_URL
    || `http://localhost:${process.env.PORT || 5100}/api`;
  if (runtimeBase && Array.isArray(spec.servers)) {
    const filtered = spec.servers.filter((s) => s.url !== runtimeBase);
    spec.servers = [{ url: runtimeBase, description: 'Current runtime' }, ...filtered];
  }

  _cachedSpec = spec;
  return spec;
}

/*
 * Express mountable. When SWAGGER_ENABLED isn't 'true', returns a 404
 * handler so the docs surface isn't even advertised. When enabled,
 * lazily builds the spec on first request + serves the standard
 * swagger-ui-express bundle.
 */
function makeDocsMiddleware() {
  if (!isEnabled()) {
    return (_req, res) => res.status(404).json({ success: false, error: 'docs disabled' });
  }
  // Lazy build: we can't call buildSpec() at module-load time because
  // routes aren't mounted yet. Instead, swagger-ui-express's `setup()`
  // accepts a function for the spec — it's called per request, but
  // buildSpec() memoises so the cost is one-time.
  return [
    ...swaggerUi.serve,
    (req, res, next) => swaggerUi.setup(buildSpec(), {
      customSiteTitle: 'EasyFix Backend API',
      swaggerOptions: {
        persistAuthorization: true,
        // Hide the Models section entirely — most users come for endpoints,
        // not schema dumps.
        defaultModelsExpandDepth: -1,
        // 'list' is the safe sweet spot:
        //   - Tag groups (Auth, Admin, Mobile, …) are expanded so users can
        //     scan the endpoint inventory at a glance
        //   - Individual operations are COLLAPSED — clicking an operation
        //     row toggles its detail panel
        // We tried 'none' (all tags collapsed) but the auto-generated path
        // wiring + swagger-ui-express v5 click bindings interact badly when
        // tags start collapsed AND paths are dynamically built — tag clicks
        // silently no-op. 'list' avoids this; if we need start-collapsed
        // tags later, we'll inject a custom JS init step instead of relying
        // on docExpansion.
        docExpansion: 'list',
        filter: true,
        tagsSorter: 'alpha',
        operationsSorter: 'alpha',
      },
      // Injects the Quick Login button — see QUICK_LOGIN_JS above for the
      // rationale. swagger-ui-express interpolates `customJsStr` into a
      // <script> tag rendered AFTER the swagger-ui bundle initialises,
      // which is why the IIFE polls for `window.ui.preauthorizeApiKey`
      // before binding the button.
      customJsStr: QUICK_LOGIN_JS,
      customCss: SWAGGER_THEME_CSS,
    })(req, res, next),
  ];
}

function jsonSpecHandler(_req, res) {
  if (!isEnabled()) {
    return res.status(404).json({ success: false, error: 'docs disabled' });
  }
  res.json(buildSpec());
}

module.exports = {
  isEnabled,
  init,
  makeDocsMiddleware,
  jsonSpecHandler,
};
