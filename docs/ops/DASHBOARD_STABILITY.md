---
title: "Dashboard Stability Investigation"
---

# Dashboard stability investigation

## Open bug: browser tab crashes after about one hour

**Reported:** 2026-10-02. **Status:** user-reported, not reproduced or diagnosed.

The user reports that leaving a RedRouter browser tab open for approximately one hour causes
the tab to crash. A browser memory leak is suspected; the cause has not been established.
The affected page, browser/version, RedRouter version, traffic level and background-tab state
have not yet been captured. Investigate this before claiming long-duration dashboard stability.

### Investigation

- Capture the affected page and browser crash details, then reproduce with the same workload.
  Compare an idle dashboard with one receiving traffic, both visible and in the background.
- Record browser-process memory and retained JavaScript heap at baseline and after 15, 30, 60
  and 90 minutes. Compare heap snapshots after collection, detached DOM nodes and pending work.
- Inspect polling overlap, timers, event listeners, stream subscriptions, chart histories and
  client caches for accumulation and missing cleanup. These are hypotheses, not confirmed causes.
- Check resource counts before and after navigation, unmount/remount and background-tab resume.
  Distinguish browser heap growth from server memory, GPU/browser faults and request failures.

### Completion criteria

- Identify the failing path with measured evidence and add a focused regression for the cause.
- Under a fixed workload, retained resources remain bounded and owned work is released on cleanup.
- A browser session lasting at least 90 minutes survives the reported scenario and navigation or
  background-tab transitions without a tab crash. Record browser/version, workload and measurements.
- Run regression/build validation in CI. Use an explicit on-demand long-duration check; do not
  introduce scheduled workflows or treat a short smoke test as proof of hour-long stability.
