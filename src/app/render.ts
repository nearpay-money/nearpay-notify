/**
 * Rendering (lld/notify.md §4): content blocks → MJML in the shared layout
 * (`templates/email/layout.mjml`) → HTML, plus the plain-text part. MJML is validated strictly, so
 * a broken template fails its snapshot test and the startup self-check, never a send.
 */
import { readFileSync } from "node:fs";
import mjml2html from "mjml";
import { contentMjml, contentText, escapeHtml, fillLayout, safeSubject } from "../domain/template/blocks.js";
import { FOOTER, type Locale, renderContent, type TemplateName } from "../domain/template/catalogue.js";

export const LAYOUT_PATH = new URL("../../templates/email/layout.mjml", import.meta.url);

export interface RenderedEmail {
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export type Renderer = (template: TemplateName, variables: unknown, locale: Locale) => Promise<RenderedEmail>;

export function createRenderer(layout: string = readFileSync(LAYOUT_PATH, "utf8")): Renderer {
  return async (template, variables, locale) => {
    const content = renderContent(template, variables, locale);
    const subject = safeSubject(content.subject);
    const mjml = fillLayout(layout, {
      lang: locale,
      title: escapeHtml(subject),
      preheader: escapeHtml(content.preheader),
      content: contentMjml(content),
      footer: escapeHtml(FOOTER[locale]),
    });
    const r = await mjml2html(mjml, { validationLevel: "strict", keepComments: false });
    if (r.errors.length)
      throw new Error(`MJML errors in ${template}: ${r.errors.map((e) => e.formattedMessage).join("; ")}`);
    return { subject, html: r.html, text: contentText(content, FOOTER[locale]) };
  };
}
