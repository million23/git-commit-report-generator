import {
  cancel,
  intro,
  isCancel,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { $ } from "bun";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import picocolors from "picocolors";

process.stdout.write("\x1Bc");

const API_KEY = process.env.GEMINI_API_KEY;
const AI_MODEL = process.env.AI_MODEL || "gemini-1.5-flash"; // Fallback to flash
const REPO_LIST_FILE = join(import.meta.dir, "repos.txt");

function formatToday() {
  return new Date().toISOString().slice(0, 10);
}

async function copyToClipboard(text: string) {
  const encoder = new TextEncoder();
  const payload = encoder.encode(text);
  const platform = process.platform;
  const commands =
    platform === "win32"
      ? [["cmd", "/c", "clip"]]
      : platform === "darwin"
        ? [["pbcopy"]]
        : [["xclip", "-selection", "clipboard"], ["wl-copy"]];

  let lastError: unknown;
  for (const cmd of commands) {
    try {
      const proc = Bun.spawn({
        cmd,
        stdin: payload,
        stdout: "ignore",
        stderr: "ignore",
      });
      const exitCode = await proc.exited;
      if (exitCode === 0) {
        return;
      }
      lastError = new Error(`Clipboard command failed: ${cmd.join(" ")}`);
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? new Error("No clipboard command succeeded.");
}

async function generateReport() {
  intro(picocolors.bgCyan(picocolors.black(" Git Weekly Report Generator ")));

  if (!API_KEY) {
    cancel("Missing GEMINI_API_KEY. Please export it in your shell.");
    process.exit(1);
  }

  if (!existsSync(REPO_LIST_FILE)) {
    cancel(`Missing config: ${REPO_LIST_FILE} not found.`);
    process.exit(1);
  }

  const repoPaths = readFileSync(REPO_LIST_FILE, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && existsSync(line));

  const selectedPath = await select({
    message: "Select a repository:",
    options: repoPaths.map((path) => ({
      value: path,
      label: path.split("/").pop() || path,
      hint: path,
    })),
  });
  if (isCancel(selectedPath)) {
    cancel("Cancelled.");
    process.exit(0);
  }

  const today = formatToday();
  const dateFrom = await text({
    message: "Date from (YYYY-MM-DD):",
    initialValue: today,
    placeholder: today,
    validate: (value) =>
      !/^\d{4}-\d{2}-\d{2}$/.test(value)
        ? "Invalid format. Use YYYY-MM-DD"
        : undefined,
  });
  if (isCancel(dateFrom)) {
    cancel("Cancelled.");
    process.exit(0);
  }

  const dateTo = await text({
    message: "Date to (YYYY-MM-DD):",
    initialValue: today,
    placeholder: today,
    validate: (value) =>
      !/^\d{4}-\d{2}-\d{2}$/.test(value)
        ? "Invalid format. Use YYYY-MM-DD"
        : undefined,
  });
  if (isCancel(dateTo)) {
    cancel("Cancelled.");
    process.exit(0);
  }

  const s = spinner();

  try {
    s.start(`Extracting logs between ${dateFrom} and ${dateTo}...`);

    // Using %ad with a full date format helps AI parse days correctly
    const logData =
      await $`git -C ${selectedPath} log -g --since=${dateFrom} --until=${dateTo} --format="Date: %ad | Ref: %D | Msg: %s" --date=format:"%Y-%m-%d"`.text();

    if (!logData.trim()) {
      s.stop("No logs found.");
      outro(
        picocolors.yellow(
          `No activity found between ${dateFrom} and ${dateTo}.`,
        ),
      );
      return;
    }
    s.stop("Git logs extracted.");

    s.start("Gemini is rebuilding your task list...");
    const genAI = new GoogleGenerativeAI(API_KEY);
    const model = genAI.getGenerativeModel({ model: AI_MODEL });

    const prompt = `
      Transform the provided git reflog into a work report with this structure:

      [date (m/d)]
      - [proper branch name (without feat/, fix/, chore/, etc.)]
        - [task description], [percentage of completion], [hours taken]

      STRICT REQUIREMENTS:
      1. GROUPING: Group tasks first by date, then by the specific branch name.
      2. BRANCH NAMES: Extract the branch name from the 'Ref' field (e.g., 'feat/facesheet'). If the ref is just 'HEAD', infer context from the message or use 'main'.
      3. TASK CLEANUP: Remove prefixes like "feat:", "fix:", or "chore:".
      4. COMPLETION: Mark as "100%" unless the message explicitly says "WIP" or "working on".
      5. THE 9-HOUR RULE: For every unique date, the sum of "hours taken" for all tasks on that day must equal EXACTLY 9 hours. 
      6. DISTRIBUTE: Distribute the 9 hours across the day's tasks based on complexity. For example, if there are 3 tasks, you might assign 3, 4, and 2 hours respectively.
      7. TASK DESCRIPTION: The task description should be a concise description of the task.
      8. PERCENTAGE OF COMPLETION: The percentage of completion should be a number between 0 and 100.
      9. HOURS TAKEN: The hours taken should be a number between 0 and 9 with a precision of 1 decimal place and multiple of 0.25.
      10. TASK LIST: The task list should be a list of tasks.
      11. SORING: sort the tasks from oldest to newest.
      12. MERGE MESSAGES: do not include merge requests or any merge related tasks  

      LOG DATA:
      ${logData}
    `;

    const result = await model.generateContent(prompt);
    const finalReport = result.response.text();
    s.stop("Report ready!");

    note(finalReport, `Weekly Summary (${dateFrom} to ${dateTo})`);

    try {
      await copyToClipboard(finalReport);
      outro(picocolors.green("Report copied to clipboard! ✅"));
    } catch {
      outro(picocolors.green("Report generated successfully!"));
    }
  } catch (err) {
    s.stop("Critical Error.");
    cancel(String(err));
  }
}

generateReport();
