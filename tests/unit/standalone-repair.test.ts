import { expect, test } from "vitest";
import { StandaloneDestinationNotIgnoredError } from "../../src/lib/standalone.ts";

test.each([".trees'one/", ".trees'$(touch sentinel)/", ".trees%name/"])(
  "repair guidance does not interpolate a personalized rule into shell code (%s)",
  (rule) => {
    const error = new StandaloneDestinationNotIgnoredError("/repo/trees/branch", rule);
    expect(error.details.repairCommands).toEqual(["arashi init --zero-config"]);
  },
);
