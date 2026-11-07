/**
 * Email content model (lld/notify.md §4). Templates produce structured blocks; this module turns
 * them into MJML (HTML part) and plain text. Pure: every value is escaped here, links are checked.
 */

export type Block =
  | { readonly kind: "p"; readonly text: string }
  | { readonly kind: "facts"; readonly rows: readonly (readonly [label: string, value: string])[] }
  | { readonly kind: "code"; readonly label: string; readonly text: string }
  | { readonly kind: "button"; readonly label: string; readonly href: string }
  | { readonly kind: "links"; readonly label: string; readonly hrefs: readonly string[] }
  | { readonly kind: "note"; readonly text: string }
  /** A highlighted line: `info` (soft mint) for requests and hints, `warning` (warm cream) for test mode and cautions. */
  | { readonly kind: "callout"; readonly tone: "info" | "warning"; readonly text: string };

export interface Content {
  readonly subject: string;
  /** Inbox preview line. */
  readonly preheader: string;
  readonly heading: string;
  readonly blocks: readonly Block[];
}

const ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/** HTML-escapes text (element content and attribute values). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ENTITIES[c] as string);
}

export class LinkError extends Error {
  constructor(href: string) {
    super(`refusing to render link ${JSON.stringify(href)}: only absolute http(s) URLs`);
    this.name = "LinkError";
  }
}

/** Only absolute http(s) URLs without credentials are rendered as links. */
export function safeHref(href: string): string {
  let u: URL;
  try {
    u = new URL(href);
  } catch {
    throw new LinkError(href);
  }
  if ((u.protocol !== "https:" && u.protocol !== "http:") || u.username || u.password) throw new LinkError(href);
  return u.href;
}

/** Subject lines are single-line (header injection) and bounded. */
export function safeSubject(s: string): string {
  const one = s.replace(/[\r\n\t]+/g, " ").trim();
  return one.length > 200 ? `${one.slice(0, 197)}...` : one;
}

/**
 * NearPay brand (nearpay-brain product/design-system.md §2): deep ink text, NearPay teal actions
 * and links, warm canvas and fine borders; DM Sans when the reader has it, else the system sans
 * (mail clients cannot load the self-hosted font, and remote fonts would be a tracking request).
 */
export const BRAND = {
  ink: "#132D31",
  textSecondary: "#52676B",
  teal: "#087A68",
  canvas: "#F7F9F8",
  border: "#DCE5E3",
  softMint: "#EAF5F1",
  warningBg: "#FFF5E4",
  warningFg: "#895710",
  sans: "'DM Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif",
  mono: "SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
} as const;

const TEXT = `font-family="${BRAND.sans}" font-size="15px" line-height="24px" color="${BRAND.ink}"`;
// one value per attribute: MJML keeps the first of duplicated attributes
const HEADING = `font-family="${BRAND.sans}" font-size="22px" line-height="30px" font-weight="600" letter-spacing="-0.01em" color="${BRAND.ink}" padding-bottom="10px"`;
const NOTE = `font-family="${BRAND.sans}" font-size="13px" line-height="20px" color="${BRAND.textSecondary}"`;
const LABEL = `font-family="${BRAND.sans}" font-size="13px" line-height="20px" color="${BRAND.textSecondary}"`;
const BOX = `font-family="${BRAND.sans}" font-size="14px" line-height="20px" color="${BRAND.ink}"`;

const CALLOUT: Record<"info" | "warning", { bg: string; fg: string }> = {
  info: { bg: BRAND.softMint, fg: BRAND.ink },
  warning: { bg: BRAND.warningBg, fg: BRAND.warningFg },
};

function blockMjml(b: Block): string {
  switch (b.kind) {
    case "p":
      return `<mj-text ${TEXT}>${escapeHtml(b.text)}</mj-text>`;
    case "note":
      return `<mj-text ${NOTE}>${escapeHtml(b.text)}</mj-text>`;
    case "callout": {
      const c = CALLOUT[b.tone];
      return `<mj-table ${BOX} padding="8px 24px"><tr><td style="background-color:${c.bg};color:${c.fg};border-radius:8px;padding:12px 16px">${escapeHtml(b.text)}</td></tr></mj-table>`;
    }
    case "code":
      return `<mj-text ${LABEL} padding-bottom="4px">${escapeHtml(b.label)}</mj-text><mj-table ${BOX} padding-top="0"><tr><td style="background-color:${BRAND.canvas};border:1px solid ${BRAND.border};border-radius:8px;padding:10px 12px;font-family:${BRAND.mono};font-size:13px;word-break:break-all">${escapeHtml(b.text)}</td></tr></mj-table>`;
    case "facts":
      return `<mj-table ${BOX} cellpadding="0">${b.rows
        .map(
          ([k, v], i) =>
            `<tr><td style="color:${BRAND.textSecondary};width:40%;vertical-align:top;padding:8px 12px 8px 0;${i ? `border-top:1px solid ${BRAND.border}` : ""}">${escapeHtml(k)}</td><td style="vertical-align:top;padding:8px 0;word-break:break-word;${i ? `border-top:1px solid ${BRAND.border}` : ""}">${escapeHtml(v)}</td></tr>`,
        )
        .join("")}</mj-table>`;
    case "button":
      return `<mj-button href="${escapeHtml(safeHref(b.href))}" background-color="${BRAND.teal}" color="#FFFFFF" font-family="${BRAND.sans}" font-size="15px" font-weight="600" border-radius="8px" align="left">${escapeHtml(b.label)}</mj-button>`;
    case "links":
      return `<mj-text ${TEXT}>${escapeHtml(b.label)}<br/>${b.hrefs
        .map((h) => {
          const href = escapeHtml(safeHref(h));
          return `<a href="${href}" style="color:${BRAND.teal};word-break:break-all">${href}</a>`;
        })
        .join("<br/>")}</mj-text>`;
  }
}

/** MJML of the content blocks, to be placed in the layout's `{{content}}` slot. */
export function contentMjml(c: Content): string {
  return [`<mj-text ${HEADING}>${escapeHtml(c.heading)}</mj-text>`, ...c.blocks.map(blockMjml)].join("\n");
}

/** Plain-text part (every mail is multipart: some clients and filters read only the text). */
export function contentText(c: Content, footer: string): string {
  const lines: string[] = [c.heading, ""];
  for (const b of c.blocks) {
    switch (b.kind) {
      case "p":
      case "note":
      case "callout":
        lines.push(b.text, "");
        break;
      case "code":
        lines.push(`${b.label}:`, `  ${b.text}`, "");
        break;
      case "facts":
        for (const [k, v] of b.rows) lines.push(`${k}: ${v}`);
        lines.push("");
        break;
      case "button":
        lines.push(`${b.label}: ${safeHref(b.href)}`, "");
        break;
      case "links":
        lines.push(`${b.label}`, ...b.hrefs.map((h) => `  ${safeHref(h)}`), "");
        break;
    }
  }
  lines.push("--", footer);
  return `${lines.join("\n")}\n`;
}

/** Fills `{{name}}` slots of a layout with already-escaped MJML. Unknown slots are an error. */
export function fillLayout(layout: string, slots: Readonly<Record<string, string>>): string {
  return layout.replace(/\{\{([a-z_]+)\}\}/g, (_m, k: string) => {
    const v = slots[k];
    if (v === undefined) throw new Error(`layout slot {{${k}}} has no value`);
    return v;
  });
}
