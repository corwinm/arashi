import { describe, expect, test } from "vitest";
import { validateProbeBudget } from "../../scripts/benchmark/probe-budget.ts";

const behavior = {
  freshness: { mode: "refreshed", remoteRefsRefreshed: true },
  nativeStatus: false,
};
const metric = (main: number, child: number, unattributed = 0) => ({
  available: true,
  count: main + child * 2 + unattributed,
  method: "git-trace2-event-root-sessions" as const,
  repositories: [
    { count: main, path: "/fixture" },
    { count: child, path: "/fixture/repos/a" },
    { count: child, path: "/fixture/repos/b" },
  ],
  unattributed: { count: unattributed, reason: "Explicit unattributed sessions" },
});
const base = () => ({ behavior, metric: metric(13, 9, 8) });
const candidate = () => ({ behavior, metric: metric(7, 7) });
const options = { fixture: "small" as const, mainPath: "/fixture", verbose: false };

describe("strict canonical probe benchmark acceptance", () => {
  test("accepts strict named and aggregate reductions with complete reconciliation", () => {
    expect(() => validateProbeBudget(base(), candidate(), options)).not.toThrow();
  });
  test("compares JSON semantics independently of object key order", () => {
    const next = candidate();
    next.behavior = {
      nativeStatus: false,
      freshness: { remoteRefsRefreshed: true, mode: "refreshed" },
    };
    expect(() => validateProbeBudget(base(), next, options)).not.toThrow();
  });
  test.each([
    ["equal named count despite lower aggregate", () => ({ ...candidate(), metric: metric(7, 9) })],
    [
      "normal cap exceeded despite strict improvement",
      () => ({ ...candidate(), metric: metric(8, 7) }),
    ],
    ["unexplained unattributed", () => ({ ...candidate(), metric: metric(7, 7, 1) })],
    [
      "non-reconciling aggregate",
      () => ({ ...candidate(), metric: { ...metric(7, 7), count: 20 } }),
    ],
    [
      "missing named repository",
      () => ({
        ...candidate(),
        metric: { ...metric(7, 7), repositories: metric(7, 7).repositories.slice(1), count: 14 },
      }),
    ],
    [
      "wrong canonical repository",
      () => ({
        ...candidate(),
        metric: {
          ...metric(7, 7),
          repositories: metric(7, 7).repositories.map((r) => ({ ...r, path: r.path + "-wrong" })),
        },
      }),
    ],
    [
      "freshness drift",
      () => ({
        ...candidate(),
        behavior: { ...behavior, freshness: { mode: "local", remoteRefsRefreshed: false } },
      }),
    ],
    [
      "native output provenance drift",
      () => ({ ...candidate(), behavior: { ...behavior, nativeStatus: true } }),
    ],
  ])("rejects %s", (_label, mutate) => {
    expect(() => validateProbeBudget(base(), mutate(), options)).toThrow();
  });
  test("accepts measured base counts that change under fixture-owned symbolic HEAD state", () => {
    expect(() =>
      validateProbeBudget({ ...base(), metric: metric(11, 7, 8) }, candidate(), options),
    ).not.toThrow();
  });
  test("accepts shifted measured-base attribution when candidate beats pinned named budgets", () => {
    expect(() =>
      validateProbeBudget({ ...base(), metric: metric(9, 8, 8) }, candidate(), options),
    ).not.toThrow();
  });
});
