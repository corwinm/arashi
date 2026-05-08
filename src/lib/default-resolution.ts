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
      source: "explicit",
      value: options.explicitValue,
    };
  }

  if (options.optOut) {
    return {
      source: "opt-out",
      value: options.builtInValue,
    };
  }

  const hasConfigValue = options.hasConfigValue ?? options.configValue !== undefined;
  if (hasConfigValue && options.configValue !== undefined) {
    return {
      source: "config",
      value: options.configValue,
    };
  }

  return {
    source: "built-in",
    value: options.builtInValue,
  };
}
