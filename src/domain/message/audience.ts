/**
 * Audience selection from identity's recipient list (lld/notify.md §4). Pure.
 *
 * - `roles` narrows the list (e.g. owners only), `exclude` removes users (e.g. who already approved
 *   a destination, so the creator is never asked to approve their own destination twice);
 * - a user listed twice is mailed once (the dedupe key `<event id>:<user id>` repeats that, INV-4);
 * - `userEmails` fills variables from the full list, before the role filter: member events carry ids
 *   only, so an owner/admin is named by email and anyone identity does not list stays an id (null).
 */
import type { Role } from "./routing.js";

export interface Recipient {
  readonly user_id: string;
  readonly email: string;
  readonly role: string;
}

export function chooseRecipients<R extends Recipient>(
  list: readonly R[],
  o: { readonly roles?: readonly Role[] | undefined; readonly exclude?: readonly string[] | undefined },
): R[] {
  const excluded = new Set(o.exclude ?? []);
  const seen = new Set<string>();
  return list.filter((r) => {
    if (excluded.has(r.user_id) || seen.has(r.user_id)) return false;
    if (o.roles && !(o.roles as readonly string[]).includes(r.role)) return false;
    seen.add(r.user_id);
    return true;
  });
}

export function lookupEmails(
  list: readonly Recipient[],
  userEmails: Readonly<Record<string, string | null>> | undefined,
): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(userEmails ?? {}).map(([k, id]) => [
      k,
      id === null ? null : (list.find((r) => r.user_id === id)?.email ?? null),
    ]),
  );
}
