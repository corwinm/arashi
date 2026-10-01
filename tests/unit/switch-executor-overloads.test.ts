import { expect, expectTypeOf, test } from "vitest";
import {
  executeSwitch,
  type SwitchCommandOptions,
  type SwitchExecutionResult,
} from "../../src/commands/switch.ts";

// Never invoke: tsc exercises these public call signatures without executing handoffs.
function assertOverloads(
  optionalT3: SwitchCommandOptions & { json?: false },
  disabled: SwitchCommandOptions & { t3?: false; json?: false },
  optionalJson: SwitchCommandOptions & { t3: false },
  booleanT3: SwitchCommandOptions & { t3: boolean; json: false },
  stringT3: SwitchCommandOptions & { t3: string; json?: boolean },
  unknownOptions: SwitchCommandOptions,
) {
  expectTypeOf(executeSwitch(undefined, { t3: false, cd: true })).toEqualTypeOf<
    Promise<SwitchExecutionResult>
  >();
  expectTypeOf(executeSwitch(undefined, {})).toEqualTypeOf<Promise<SwitchExecutionResult>>();
  expectTypeOf(executeSwitch(undefined, disabled)).toEqualTypeOf<Promise<SwitchExecutionResult>>();
  expectTypeOf(executeSwitch(undefined, { t3: true })).toEqualTypeOf<Promise<number>>();
  expectTypeOf(executeSwitch(undefined, { t3: "Task" })).toEqualTypeOf<Promise<number>>();
  expectTypeOf(executeSwitch(undefined, stringT3)).toEqualTypeOf<Promise<number>>();
  expectTypeOf(executeSwitch(undefined, { t3: false, json: true })).toEqualTypeOf<
    Promise<number>
  >();
  expectTypeOf(executeSwitch(undefined, optionalT3)).toEqualTypeOf<
    Promise<SwitchExecutionResult | number>
  >();
  expectTypeOf(executeSwitch(undefined, optionalJson)).toEqualTypeOf<
    Promise<SwitchExecutionResult | number>
  >();
  expectTypeOf(executeSwitch(undefined, booleanT3)).toEqualTypeOf<
    Promise<SwitchExecutionResult | number>
  >();
  expectTypeOf(executeSwitch(undefined, unknownOptions)).toEqualTypeOf<
    Promise<SwitchExecutionResult | number>
  >();
}
test("compile-time overload assertions remain available to typecheck", () => {
  expect(typeof assertOverloads).toBe("function");
});
