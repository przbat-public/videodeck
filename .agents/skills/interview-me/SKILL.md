---
name: interview-me
description: One question at a time to extract what a videodeck feature request actually needs, until confidence reaches roughly 95 percent. Use when the ask is underspecified or contradicts the repo's existing behavior.
user-invocable: true
---

# Interview Me

> Adapted from [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills) (MIT), rewritten for videodeck conventions.

## Overview

When a request is vague, asking one sharp question at a time beats
guessing. The loop: form a hypothesis about what the user wants, ask the
single question that tests it, update the hypothesis from the answer, and
stop at roughly 95 percent confidence. Then write the spec
(`spec-driven-development`) or start the fix.

## When to Use

- The ask is one sentence with no scope ("add folders", "make search
  better")
- The ask contradicts current behavior (the queue already pauses; what
  exactly is missing?)
- The user says "grill me" or asks for the interview explicitly

## The loop

1. **State the hypothesis** in one sentence and the confidence level, e.g.
   "You want a per-folder queue size limit, 70 percent."
2. **Ask one question.** The question whose answer moves confidence the
   most. Never a list; a list invites half-answers.
3. **Record the answer** and re-estimate. Two answers pointing the same
   way means you asked the right question.
4. **Stop at ~95 percent**, then restate the full understanding in three
   lines for a final yes.

## Questions that matter for this repo

- Which surface: search, queue, status page, detail page, extension?
- Which language does the visible text lead with (pl home, en parity)?
- Does it change the API (`shared/schemas.ts`), the queue, or just UI?
- Who runs it: single self-hosted user or a LAN with several clients?
- What must NOT change (existing shortcuts, current defaults)?

## Rationalizations

| Rationalization | Reality |
| --- | --- |
| "I can ask everything in one message" | People answer the first and last question only. |
| "I already know what they mean" | Confidence below 95 percent is a guess with extra steps. |
| "Questions annoy the user" | One wrong build annoys them more. |

## Red Flags

- Asking more than one question at a time
- Building before the restated understanding got a yes
- Skipping the "what must not change" question

## Verification

- [ ] Every question was single and concrete
- [ ] Confidence was stated and updated per answer
- [ ] The final three-line restatement was confirmed before work started
