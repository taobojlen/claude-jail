import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const dir = mkdtempSync(join(tmpdir(), "scheduler-test-"));
process.env.TASKS_FILE = join(dir, "tasks.json");
process.env.SCHEDULER_API_PORT = "0";
