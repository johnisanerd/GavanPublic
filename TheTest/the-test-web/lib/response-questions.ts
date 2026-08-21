// Merge a response's actual answers with the form's FULL ordered question list
// so the response view can show questions the participant SKIPPED. Typeform only
// sends answers for questions that were answered, so skipped ones simply vanish
// from survey_answer — the only authoritative "what questions exist" source is
// the form definition (the `question` bank just accumulates questions someone
// answered, so a universally-skipped question would never appear there).

import type { Answer } from "@/app/(authed)/admin/lib";
import { getForm } from "@/lib/typeform";

export type FormField = { ref: string; title: string | null; type: string | null };

// Typeform `statement` is display-only (no answer); `group` is a container whose
// children are the real questions. Everything else is answerable. Flatten groups
// inline so nested questions keep their form order.
function flattenFields(fields: unknown[] | undefined): FormField[] {
  const out: FormField[] = [];
  for (const raw of fields ?? []) {
    const f = raw as {
      type?: string;
      ref?: string;
      title?: string;
      properties?: { fields?: unknown[] };
    };
    if (f?.type === "group") out.push(...flattenFields(f.properties?.fields));
    else if (f?.type !== "statement" && f?.ref)
      out.push({ ref: f.ref, title: f.title ?? null, type: f.type ?? null });
  }
  return out;
}

// The form definition is stable; cache it so the response view's 5s poll doesn't
// hammer the Typeform API. Module-level TTL cache (per warm lambda instance).
const FIELD_TTL_MS = 5 * 60 * 1000;
const fieldCache = new Map<string, { at: number; fields: FormField[] }>();

export async function getFormFields(formId: string): Promise<FormField[]> {
  const hit = fieldCache.get(formId);
  if (hit && Date.now() - hit.at < FIELD_TTL_MS) return hit.fields;
  const form = await getForm(formId);
  const fields = flattenFields(form?.fields);
  fieldCache.set(formId, { at: Date.now(), fields });
  return fields;
}

// Produce the full ordered question list: every form field, in form order, as
// either its answer or a `skipped` placeholder. Answers whose field isn't in the
// form (e.g. the form was edited since this response) are appended so nothing is
// lost. Returns the answers unchanged if we couldn't resolve the form's fields.
export function mergeSkippedQuestions(
  answers: Answer[],
  fields: FormField[],
): Answer[] {
  if (!fields.length) return answers;
  const byRef = new Map<string, Answer>();
  for (const a of answers) if (a.field_ref) byRef.set(a.field_ref, a);

  const used = new Set<string>();
  const merged: Answer[] = [];
  for (const f of fields) {
    const a = byRef.get(f.ref);
    if (a) {
      merged.push(a);
      used.add(f.ref);
    } else {
      merged.push({
        field_ref: f.ref,
        question_title: f.title,
        field_type: f.type,
        is_freeform: false,
        value: null,
        skipped: true,
      });
    }
  }
  for (const a of answers) if (!a.field_ref || !used.has(a.field_ref)) merged.push(a);
  return merged;
}
