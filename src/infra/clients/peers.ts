/**
 * Owner-service clients for recipient resolution (lld/notify.md §4): identity
 * `notification-recipients` and payments `receipt-context`, both with notify's service token.
 */

import type { RouteResponse } from "@nearpay/spec";
import { serviceTokenClient } from "@nearpay-internal/auth";
import { HttpError, httpClient } from "@nearpay-internal/http";
import { getNotificationRecipients, getReceiptContext } from "@nearpay-internal/spec";
import type { RecipientKind } from "../../domain/message/routing.js";

export type Recipients = RouteResponse<typeof getNotificationRecipients>["recipients"];
export type ReceiptContext = RouteResponse<typeof getReceiptContext>;

export interface Peers {
  /** null when identity does not know the account. */
  recipients(accountId: string, kind: RecipientKind): Promise<Recipients | null>;
  /** null when payments does not know the payment intent. */
  receiptContext(paymentIntentId: string): Promise<ReceiptContext | null>;
}

const missing = (e: unknown) => e instanceof HttpError && e.status === 404;

export function httpPeers(o: {
  identityUrl: string;
  paymentsUrl: string;
  serviceToken: () => Promise<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Peers {
  const common = {
    timeoutMs: o.timeoutMs ?? 3_000,
    serviceToken: o.serviceToken,
    ...(o.fetch ? { fetch: o.fetch } : {}),
  };
  const identity = httpClient({ target: "identity", baseUrl: o.identityUrl, ...common });
  const payments = httpClient({ target: "payments", baseUrl: o.paymentsUrl, ...common });
  return {
    async recipients(accountId, kind) {
      try {
        return (await identity.call(getNotificationRecipients, { params: { id: accountId }, query: { kind } }))
          .recipients;
      } catch (e) {
        if (missing(e)) return null;
        throw e;
      }
    },
    async receiptContext(paymentIntentId) {
      try {
        return await payments.call(getReceiptContext, { params: { id: paymentIntentId } });
      } catch (e) {
        if (missing(e)) return null;
        throw e;
      }
    },
  };
}

/** Service token from identity's client-credentials endpoint (client id `notify`). */
export function notifyServiceToken(identityUrl: string, secret: string, f?: typeof fetch): () => Promise<string> {
  const client = serviceTokenClient({ identityUrl, clientId: "notify", secret, ...(f ? { fetch: f } : {}) });
  return () => client.getToken();
}
