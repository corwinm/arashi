export type DefaultResolutionSource = "explicit" | "opt-out" | "config" | "built-in";

export interface DefaultResolution<T> {
  value: T;
  source: DefaultResolutionSource;
}

export interface ResolveDefaultOptions<T> {
  explicitValue?: T;
  hasExplicitValue?: boolean;
  optOut?: boolean;
  configValue?: T;
  hasConfigValue?: boolean;
  builtInValue: T;
}

export function resolveDefaultWithPrecedence<T>(
  options: ResolveDefaultOptions<T>,
): DefaultResolution<T> {
  const hasExplicitValue = options.hasExplicitValue ?? options.explicitValue !== undefined;
  if (hasExplicitValue && options.explicitValue !== undefined) {
    return {
      value: options.explicitValue,
      source: "explicit",
    };
  }

  if (options.optOut) {
    return {
      value: options.builtInValue,
      source: "opt-out",
    };
  }

  const hasConfigValue = options.hasConfigValue ?? options.configValue !== undefined;
  if (hasConfigValue && options.configValue !== undefined) {
    return {
      value: options.configValue,
      source: "config",
    };
  }

  return {
    value: options.builtInValue,
    source: "built-in",
  };
}
