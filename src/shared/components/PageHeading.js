"use client";

import { pageHeading } from "@/shared/ds/page-heading.variants";
import { translate } from "@/i18n/runtime";

// DS PageHeading: the one H1 at the root of a page's document outline, with
// optional context (breadcrumbs) above it and actions beside it.
export default function PageHeading({ title, description, context, actions, className }) {
  const slots = pageHeading();

  return (
    <div data-page-heading className={slots.root({ class: className })}>
      <div className={slots.identity({ class: "flex flex-col gap-[var(--reddb-spatial-gap-sm)]" })}>
        {context && <div className={slots.context()}>{context}</div>}
        <h1 className={slots.title()}>{translate(title)}</h1>
        {description && <p className={slots.description()}>{translate(description)}</p>}
      </div>
      {actions && <div className={slots.actions()}>{actions}</div>}
    </div>
  );
}
