export default function createBenchmarkEnvironment(
  inheritedEnvironment: NodeJS.ProcessEnv,
  ownedEnvironment: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  const sanitizedEnvironment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inheritedEnvironment)) {
    if (!key.toUpperCase().startsWith("GIT_")) {
      sanitizedEnvironment[key] = value;
    }
  }

  return { ...sanitizedEnvironment, ...ownedEnvironment };
}
