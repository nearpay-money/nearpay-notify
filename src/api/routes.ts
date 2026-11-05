/** Spec route bindings (lld/notify.md §5). Auth and scopes are enforced from the spec by the bootstrap. */
import { fromUuid } from "@nearpay-internal/ids";
import { ApiError, implement, type RouteBinding } from "@nearpay-internal/service";
import { sendMessage } from "@nearpay-internal/spec";
import type { Notify } from "../app/context.js";
import { queueApiMessage } from "../app/messages.js";
import { resolveLocale, VariablesError } from "../domain/template/catalogue.js";

export function notifyRoutes(n: Notify): RouteBinding[] {
  return [
    implement(sendMessage, async (ctx) => {
      const b = ctx.body;
      try {
        const r = await queueApiMessage(n, {
          template: b.template,
          to: b.to,
          variables: b.variables,
          locale: resolveLocale(b.locale),
          dedupeKey: b.dedupe_key,
        });
        return { message_id: fromUuid("msg", r.id) };
      } catch (e) {
        if (e instanceof VariablesError) throw ApiError.invalid(e.issues.join("; "), "variables");
        throw e;
      }
    }),
  ];
}
