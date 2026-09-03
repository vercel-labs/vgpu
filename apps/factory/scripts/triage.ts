#!/usr/bin/env node

import { main } from "../src/cli.ts";

process.exitCode = await main();
