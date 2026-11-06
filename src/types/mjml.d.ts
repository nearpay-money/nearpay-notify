/** mjml 5 (ships no types; `@types/mjml` describes the synchronous v4 API). */
declare module "mjml" {
  export interface MjmlError {
    line: number;
    message: string;
    tagName: string;
    formattedMessage: string;
  }
  export interface MjmlResult {
    html: string;
    errors: MjmlError[];
  }
  export interface MjmlOptions {
    validationLevel?: "strict" | "soft" | "skip";
    keepComments?: boolean;
    minify?: boolean;
    beautify?: boolean;
  }
  export default function mjml2html(input: string, options?: MjmlOptions): Promise<MjmlResult>;
}
