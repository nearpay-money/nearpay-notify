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
  | { readonly kind: "note"; readonly text: string };

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

const TEXT = 'font-family="Helvetica, Arial, sans-serif" font-size="15px" line-height="22px" color="#1f2328"';
const NOTE = 'font-family="Helvetica, Arial, sans-serif" font-size="12px" line-height="18px" color="#656d76"';
const MONO = 'font-family="Menlo, Consolas, monospace" font-size="13px" line-height="20px" color="#1f2328"';

function blockMjml(b: Block): string {
  switch (b.kind) {
    case "p":
      return `<mj-text ${TEXT}>${escapeHtml(b.text)}</mj-text>`;
    case "note":
      return `<mj-text ${NOTE}>${escapeHtml(b.text)}</mj-text>`;
    case "code":
      return `<mj-text ${NOTE} padding-bottom="0">${escapeHtml(b.label)}</mj-text><mj-text ${MONO} padding-top="2px">${escapeHtml(b.text)}</mj-text>`;
    case "facts":
      return `<mj-table ${TEXT} cellpadding="4px">${b.rows
        .map(
          ([k, v]) =>
            `<tr><td style="color:#656d76;width:40%;vertical-align:top">${escapeHtml(k)}</td><td style="vertical-align:top;word-break:break-all">${escapeHtml(v)}</td></tr>`,
        )
        .join("")}</mj-table>`;
    case "button":
      return `<mj-button href="${escapeHtml(safeHref(b.href))}" background-color="#1f2328" color="#ffffff" font-family="Helvetica, Arial, sans-serif" font-size="15px" border-radius="6px" align="left">${escapeHtml(b.label)}</mj-button>`;
    case "links":
      return `<mj-text ${TEXT}>${escapeHtml(b.label)}<br/>${b.hrefs
        .map((h) => {
          const href = escapeHtml(safeHref(h));
          return `<a href="${href}" style="color:#0969da;word-break:break-all">${href}</a>`;
        })
        .join("<br/>")}</mj-text>`;
  }
}

/** MJML of the content blocks, to be placed in the layout's `{{content}}` slot. */
export function contentMjml(c: Content): string {
  return [
    `<mj-text ${TEXT} font-size="20px" font-weight="bold">${escapeHtml(c.heading)}</mj-text>`,
    ...c.blocks.map(blockMjml),
  ].join("\n");
}

/** Plain-text part (every mail is multipart: some clients and filters read only the text). */
export function contentText(c: Content, footer: string): string {
  const lines: string[] = [c.heading, ""];
  for (const b of c.blocks) {
    switch (b.kind) {
      case "p":
      case "note":
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
