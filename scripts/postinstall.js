#!/usr/bin/env node

import { runInstallCli } from "../bin/install-binary.js";

process.exitCode = await runInstallCli();
