"use client";

import { useRef, useState, type ReactNode } from "react";
import { sidebarRail } from "@/shared/design-system/contracts/sidebar-rail.variants";
import { tooltip } from "@/shared/design-system/contracts/tooltip.variants";
import Icon from "@/shared/components/Icon";
import { navIcon } from "@/shared/icons/navIcons";

export interface RailArea {
  id: string;
  label: string;
  /** A lucide glyph name. */
  icon: string;
}

export interface RailAction {
  id: string;
  label: string;
  icon: string;
  onSelect: () => void;
}

interface SidebarRailProps {
  label: string;
  areas: readonly RailArea[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** The brand mark, once, at the top (the DS puts it in the rail's top region). */
  top?: ReactNode;
  /** Plain buttons at the bottom: search, the panel toggle, restart, shutdown. */
  actions?: readonly RailAction[];
  /** Pressed state of an action, when it toggles something. */
  pressedActionId?: string | null;
  paddingTop?: string;
}

interface TipState {
  label: string;
  x: number;
  y: number;
}

/**
 * The narrow icon rail: one button per area, appearance from the DS `sidebar-rail` contract.
 * Selection is `aria-pressed`, there is one tab stop and the arrow keys move between areas,
 * like the DS `SidebarRail`. The rail holds no selection state of its own.
 */
export default function SidebarRail({
  label,
  areas,
  selectedId,
  onSelect,
  top,
  actions = [],
  pressedActionId = null,
  paddingTop,
}: SidebarRailProps) {
  const slots = sidebarRail();
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const [focusIndex, setFocusIndex] = useState(0);
  const [tip, setTip] = useState<TipState | null>(null);

  const showTip = (event: React.SyntheticEvent<HTMLElement>, text: string) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setTip({ label: text, x: rect.right + 8, y: rect.top + rect.height / 2 });
  };
  const hideTip = () => setTip(null);

  const moveFocus = (next: number) => {
    const clamped = (next + areas.length) % areas.length;
    setFocusIndex(clamped);
    refs.current[clamped]?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>, index: number) => {
    if (event.key === "ArrowDown") moveFocus(index + 1);
    else if (event.key === "ArrowUp") moveFocus(index - 1);
    else if (event.key === "Home") moveFocus(0);
    else if (event.key === "End") moveFocus(areas.length - 1);
    else return;
    event.preventDefault();
  };

  const tabStop = Math.min(focusIndex, areas.length - 1);

  return (
    <>
      <nav
        aria-label={label}
        data-density="spacious"
        className={slots.root()}
        style={{ paddingTop }}
      >
        {top && <div className={slots.region()}>{top}</div>}
        <div className={slots.middle()}>
          <ul className={slots.list()}>
            {areas.map((area, index) => (
              <li key={area.id}>
                <button
                  type="button"
                  ref={(node) => {
                    refs.current[index] = node;
                  }}
                  className={slots.item()}
                  aria-pressed={area.id === selectedId}
                  aria-label={area.label}
                  tabIndex={index === tabStop ? 0 : -1}
                  onClick={() => onSelect(area.id)}
                  onFocus={(event) => {
                    setFocusIndex(index);
                    showTip(event, area.label);
                  }}
                  onBlur={hideTip}
                  onMouseEnter={(event) => showTip(event, area.label)}
                  onMouseLeave={hideTip}
                  onKeyDown={(event) => onKeyDown(event, index)}
                >
                  <span className={slots.fallback()}>
                    <Icon icon={navIcon(area.icon)} size="lg" color="current" />
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
        {actions.length > 0 && (
          <div className={slots.region()}>
            <ul className={slots.list()}>
              {actions.map((action) => (
                <li key={action.id}>
                  <button
                    type="button"
                    className={slots.item()}
                    aria-label={action.label}
                    aria-pressed={pressedActionId === action.id ? true : undefined}
                    onClick={action.onSelect}
                    onFocus={(event) => showTip(event, action.label)}
                    onBlur={hideTip}
                    onMouseEnter={(event) => showTip(event, action.label)}
                    onMouseLeave={hideTip}
                  >
                    <span className={slots.fallback()}>
                      <Icon icon={navIcon(action.icon)} size="lg" color="current" />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </nav>
      {tip && (
        <div
          role="tooltip"
          className={`${tooltip()} pointer-events-none fixed`}
          style={{ left: tip.x, top: tip.y, transform: "translateY(-50%)" }}
        >
          {tip.label}
        </div>
      )}
    </>
  );
}
