// Chart series colours from the design system: series 1-6 (red, blue, green,
// amber, violet, cyan), each tuned for the light and dark colour schemes.
// The plain --reddb-* properties are always in the stylesheet; Tailwind only
// emits its --color-series-* aliases when a utility class uses them.
export const SERIES_COLORS = [1, 2, 3, 4, 5, 6].map((n) => `var(--reddb-color-series-${n})`);

/** The colour of the i-th series (0-based), cycling through the six. */
export const seriesColor = (i) => SERIES_COLORS[((i % SERIES_COLORS.length) + SERIES_COLORS.length) % SERIES_COLORS.length];

export const SERIES = { red: SERIES_COLORS[0], blue: SERIES_COLORS[1], green: SERIES_COLORS[2], amber: SERIES_COLORS[3], violet: SERIES_COLORS[4], cyan: SERIES_COLORS[5] };

// Feedback role for a failing series (error edges, failed requests).
export const DANGER_COLOR = "var(--reddb-color-feedback-danger-foreground)";
