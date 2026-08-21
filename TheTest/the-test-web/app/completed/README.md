# `/completed` — post-survey landing

Typeform redirects participants here after they finish the form. Two behaviors:

1. **Prolific study** (`study_id` present, or `channel=prolific`): resolve the
   study's success completion code live from the Prolific API and 302 to
   `https://app.prolific.com/submissions/complete?cc=<code>` so the submission
   is registered (and auto-approved). No per-study/per-cohort config needed.
2. **Anything else**: render a branded "You're all done — thank you" no-op page.

It **never 500s** — if the Prolific lookup fails it falls back to an optional
`cohort.prolific_completion_code` override column, and failing that renders the
thank-you page with a "return to Prolific" note.

## Prolific `completion_codes` shape (confirmed against the live API)

`GET https://api.prolific.com/api/v1/studies/{study_id}/` (header
`Authorization: Token <PROLIFIC_API_TOKEN>` — note `Token`, not `Bearer`)
returns a study object containing:

```json
"completion_codes": [
  {
    "code": "EXAMPLECODE",
    "code_type": "COMPLETED",
    "actions": [{ "action": "AUTOMATICALLY_APPROVE" }],
    "actor": "participant"
  }
]
```

`lib/prolific.ts` picks the code by: (1) `code_type === "COMPLETED"`, else
(2) a code whose `actions` include an `*APPROVE*` action, else (3) the first
code present.

## Typeform "Redirect on completion" — ALREADY APPLIED via API

The redirect is set **once** on the form (id `FORMID0001`), so there is **zero
per-cohort Typeform setup**. Typeform recalls hidden-field values into the
redirect URL using `{{hidden:<fieldname>}}` tokens. This was set on
`settings.redirect_after_submit_url` and verified by reading the form back —
Typeform preserves the recall tokens verbatim.

Current value on the form:

```
https://the-test.org/completed?study_id={{hidden:study_id}}&session_id={{hidden:session_id}}&cohort={{hidden:cohort}}&channel={{hidden:channel}}&prolific_pid={{hidden:prolific_pid}}
```

### To re-apply or change it via API

```bash
# GET the form, set settings.redirect_after_submit_url to the URL above, PUT it
# back (full form object). Auth: Bearer <TYPEFORM_API_TOKEN>.
# See the round-trip script pattern used during build; always GET → mutate → PUT
# the whole form object (Typeform's PUT replaces the form).
```

### Manual UI fallback (if ever editing by hand)

Form → **Endings/Settings → Redirect on completion** → paste the URL above. In
the UI, type the static URL then use the **recall** (+) menu to insert each
hidden field at the right place; the UI stores them as field references but they
render to the live hidden values on submit.

## Env vars to set in Vercel (production)

- `PROLIFIC_API_TOKEN` — **required** for the Prolific completion redirect.
  Without it, Prolific participants get the graceful thank-you fallback instead
  of being sent back to Prolific.
- `NEXT_PUBLIC_APP_URL` — optional, defaults to `https://the-test.org`.
