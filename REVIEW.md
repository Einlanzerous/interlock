# Review instructions

What a review of **this** repository is for. The procedure lives in construct-server;
this file is the judgement.

## Frontend (diffs that touch `.vue` or `.css`)

Firefox is the primary browser (`CLAUDE.md`, Browser target). Each of these is
**Important** unless noted:

- motion (a transition, animation or smooth scroll) not gated on
  `prefers-reduced-motion` (`app.vue` carries a global override; new motion must not
  defeat it);
- a modal that is not a `<dialog>` opened with `showModal()` (a non-modal `popover` for a
  menu or picker is fine);
- an Enter handler that does not guard `e.isComposing` (an IME commit would trigger it);
- `outline: none` without a `:focus-visible` ring beside it;
- a CSS feature Firefox 160 lacks (check MDN) that is not behind `@supports` with a
  working fallback, anchor positioning being the usual one;
- a `::-webkit-` rule without its standard property (`scrollbar-width` and
  `scrollbar-color` for scrollbars);
- an icon-only button without an `aria-label`.
