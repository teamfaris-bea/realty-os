// The widget's configuration, read from its own <script> tag (the embed snippet a team copies from Realty OS):
//
//   <script src="https://app.example.com/widget/chat.js" defer
//           data-widget-key="…" data-brokerage="Harbor Realty LLC"
//           data-disclosure-id="…" data-disclosure="By starting a chat you agree …"></script>
//
// The brokerage name and the disclosure are shown before the first message; the disclosure id is sent at start
// so the server records exactly which stored text the visitor saw (consent_disclosures). `data-api` overrides
// the API base (default: the script's own origin + /api). A missing key, brokerage or disclosure renders
// nothing: the widget never shows a chat it cannot start honestly.

export interface WidgetConfig {
  widgetKey: string;
  brokerage: string;
  disclosureId: string;
  disclosure: string;
  apiBase: string;
}

export function readConfig(el: HTMLScriptElement | null, pageUrl: string): WidgetConfig | null {
  if (!el) return null;
  const d = el.dataset;
  const widgetKey = (d.widgetKey ?? '').trim();
  const brokerage = (d.brokerage ?? '').trim();
  const disclosureId = (d.disclosureId ?? '').trim();
  const disclosure = (d.disclosure ?? '').trim();
  if (!widgetKey || !brokerage || !disclosureId || !disclosure) return null;
  let apiBase = (d.api ?? '').trim();
  if (!apiBase) {
    try {
      apiBase = `${new URL(el.src || pageUrl, pageUrl).origin}/api`;
    } catch {
      return null;
    }
  }
  return { widgetKey, brokerage: brokerage.slice(0, 120), disclosureId, disclosure: disclosure.slice(0, 2000), apiBase };
}
