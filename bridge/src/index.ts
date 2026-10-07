#!/usr/bin/env -S npx tsx
import { runBridge } from "./bridge.js";

try {
  await runBridge();
} catch (error) {
  console.error(`warren-bridge: ${(error as Error).message}`);
  process.exit(1);
}
