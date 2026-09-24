"use client";

import Link from "next/link";
import { breadcrumbs } from "@/shared/ds/breadcrumbs.variants";
import { translate } from "@/i18n/runtime";

// DS Breadcrumbs: an ordered list in a labelled nav; the last item is the
// current page and every separator is decorative.
export default function Breadcrumbs({ items = [], label = "Breadcrumb", className }) {
  if (items.length === 0) return null;
  const styles = breadcrumbs();

  return (
    <nav aria-label={label} className={styles.root({ class: ["text-sm", className] })}>
      <ol className={styles.list()}>
        {items.map((item, index) => {
          const isCurrent = index === items.length - 1;
          const text = translate(item.label);
          return (
            <li key={`${item.label}-${item.href || index}`} className={styles.item()}>
              {isCurrent ? (
                <span aria-current="page" className={styles.current()}>{text}</span>
              ) : item.href ? (
                <Link href={item.href} className="text-ink-muted underline-offset-4 hover:text-foreground hover:underline">
                  {text}
                </Link>
              ) : (
                <span className="text-ink-muted">{text}</span>
              )}
              {!isCurrent && <span aria-hidden="true" className={styles.separator()}>/</span>}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
