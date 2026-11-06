/** Email provider port (lld/notify.md §6): SMTP locally (Mailpit); Postmark + SES on the server (Stage 5). */
import type { SendFailure } from "../domain/message/policy.js";

export interface OutgoingEmail {
  /** Stable id (the message id): the `Message-ID` header, so a retried send can be deduplicated. */
  readonly id: string;
  readonly from: string;
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
}

export interface EmailProvider {
  readonly name: string;
  /** Resolves with the provider's message id; rejects with a `ProviderError`. */
  send(m: OutgoingEmail): Promise<{ providerMessageId: string }>;
  close?(): Promise<void>;
}

export class ProviderError extends Error implements SendFailure {
  constructor(
    message: string,
    readonly permanent: boolean,
    readonly recipientRejected = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
