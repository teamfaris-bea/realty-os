// The widget's styles, inside its own shadow root so the brokerage's site cannot restyle it and it cannot
// restyle the site. Phone-first: under 480 px the panel takes the whole screen (and is then modal, widget.ts); every
// control is at least 44 × 44 px; light and dark follow the visitor's setting; text contrast is AA or better in both.

/** Where the panel takes the whole screen (and widget.ts makes it modal: the page behind it is covered). */
export const FULL_SCREEN_MEDIA = '(max-width:479.98px)';

export const CSS = `
:host{all:initial}
*{box-sizing:border-box}
.w{font:16px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;color:#111827;
--bg:#fff;--bg2:#f3f4f6;--ink:#111827;--muted:#4b5563;--line:#d1d5db;--accent:#1d4ed8;--accent-ink:#fff;--soft:#dbeafe;--danger:#b91c1c}
@media (prefers-color-scheme:dark){.w{--bg:#111827;--bg2:#1f2937;--ink:#f9fafb;--muted:#d1d5db;--line:#4b5563;--accent:#93c5fd;--accent-ink:#0b1220;--soft:#1e3a8a;--danger:#fca5a5;color:#f9fafb}}
button,input,textarea{font:inherit;color:inherit}
.launch{position:fixed;right:16px;bottom:16px;z-index:2147483646;min-height:48px;padding:0 18px;border:0;border-radius:24px;
background:var(--accent);color:var(--accent-ink);font-weight:600;box-shadow:0 4px 14px rgba(0,0,0,.25);cursor:pointer}
.panel{position:fixed;right:16px;bottom:16px;z-index:2147483647;width:380px;max-width:calc(100vw - 32px);height:min(640px,calc(100vh - 32px));
display:flex;flex-direction:column;background:var(--bg);color:var(--ink);border:1px solid var(--line);border-radius:16px;box-shadow:0 8px 30px rgba(0,0,0,.3);overflow:hidden}
@media ${FULL_SCREEN_MEDIA}{.panel{inset:0;width:100%;max-width:none;height:100%;border-radius:0;border:0}}
.head{display:flex;align-items:center;gap:8px;padding:8px 8px 8px 16px;border-bottom:1px solid var(--line)}
.head h2{flex:1;margin:0;font-size:17px;font-weight:600;overflow-wrap:anywhere}
.x{min-width:44px;min-height:44px;border:0;border-radius:10px;background:transparent;cursor:pointer;font-size:15px;color:var(--ink);text-decoration:underline}
.body{flex:1;overflow-y:auto;padding:12px 16px;display:flex;flex-direction:column;gap:10px}
.note{margin:0;font-size:14px;color:var(--muted)}
.disc{margin:0;font-size:14px;color:var(--ink);background:var(--bg2);border-radius:10px;padding:8px 10px;white-space:pre-wrap;overflow-wrap:anywhere}
.ai{margin:0;font-size:14px;font-weight:600;color:var(--ink)}
form{display:flex;flex-direction:column;gap:8px}
label{display:flex;flex-direction:column;gap:4px;font-size:15px;font-weight:600}
input,textarea{min-height:44px;padding:8px 12px;border:1px solid var(--line);border-radius:10px;background:var(--bg);font-weight:400;font-size:16px}
textarea{resize:vertical;min-height:72px}
.hint{font-size:13px;font-weight:400;color:var(--muted)}
.go{min-height:44px;padding:0 16px;border:0;border-radius:10px;background:var(--accent);color:var(--accent-ink);font-weight:600;cursor:pointer}
.go[aria-disabled=true]{opacity:.7;cursor:progress}
.err{margin:0;font-size:14px;font-weight:600;color:var(--danger)}
.log{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:8px}
.m{max-width:85%;display:flex;flex-direction:column;gap:2px}
.m.v{align-self:flex-end;align-items:flex-end}
.m.t{align-self:flex-start;align-items:flex-start}
.b{margin:0;padding:8px 12px;border-radius:14px;white-space:pre-wrap;overflow-wrap:anywhere}
.v .b{background:var(--soft)}
.t .b{background:var(--bg2)}
.meta{font-size:12px;color:var(--muted)}
.foot{border-top:1px solid var(--line);padding:8px 12px calc(8px + env(safe-area-inset-bottom))}
.row{display:flex;gap:8px;align-items:flex-end}
.row textarea{flex:1;min-height:44px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
`;
