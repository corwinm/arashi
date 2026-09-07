function childIsRunning(child) {
  return child.exitCode === null && child.signalCode === null;
}

export function waitForOutput(child, marker, timeoutMs) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let exit = null;
    let settled = false;

    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off("data", onStdout);
      child.stderr?.off("data", onStderr);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("close", onClose);
    };
    const finish = (action, value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      action(value);
    };
    const diagnostics = () => {
      const detail = stderr.trim();
      return detail ? `: ${detail}` : "";
    };
    const onStdout = (chunk) => {
      stdout += chunk.toString();
      if (stdout.includes(marker)) {
        finish(resolve, stdout);
      }
    };
    const onStderr = (chunk) => {
      stderr += chunk.toString();
    };
    const onError = (error) => {
      finish(
        reject,
        new Error(
          `holder failed before output contained ${JSON.stringify(marker)}: ${error.message}${diagnostics()}`,
          { cause: error },
        ),
      );
    };
    const onExit = (code, signal) => {
      exit = { code, signal };
    };
    const onClose = (code, signal) => {
      const statusCode = exit?.code ?? code;
      const statusSignal = exit?.signal ?? signal;
      const status = statusCode === null ? `signal ${statusSignal}` : `code ${statusCode}`;
      finish(
        reject,
        new Error(
          `holder exited with ${status} before output contained ${JSON.stringify(marker)}${diagnostics()}`,
        ),
      );
    };
    const timer = setTimeout(() => {
      finish(
        reject,
        new Error(
          `holder timed out after ${timeoutMs}ms waiting for output ${JSON.stringify(marker)}${diagnostics()}`,
        ),
      );
    }, timeoutMs);

    child.stdout?.on("data", onStdout);
    child.stderr?.on("data", onStderr);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);

    if (!childIsRunning(child)) {
      onExit(child.exitCode, child.signalCode);
      if (
        (!child.stdout || child.stdout.readableEnded) &&
        (!child.stderr || child.stderr.readableEnded)
      ) {
        onClose(child.exitCode, child.signalCode);
      }
    }
  });
}

export function terminateChild(child, timeoutMs) {
  if (!childIsRunning(child)) {
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      child.off("close", onClose);
      child.off("error", onError);
    };
    const finish = (action, value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      action(value);
    };
    const onClose = () => finish(resolve);
    const onError = (error) => finish(reject, error);
    const timer = setTimeout(
      () =>
        finish(reject, new Error(`holder did not close within ${timeoutMs}ms after termination`)),
      timeoutMs,
    );

    child.once("close", onClose);
    child.once("error", onError);
    if (!child.kill()) {
      finish(reject, new Error("failed to terminate holder process"));
    }
  });
}
