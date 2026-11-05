// Prompts for a password (input hidden) and prints a bcrypt hash for ACCOUNT_PASSWORD_HASH.
import bcrypt from "bcryptjs";
import { createInterface } from "node:readline";

async function ask(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    // Piped input: read one line.
    const rl = createInterface({ input: process.stdin });
    for await (const line of rl) return line;
    return "";
  }
  process.stdout.write(prompt);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";
  return new Promise((resolve) => {
    const onData = (buf: Buffer) => {
      for (const ch of buf.toString("utf8")) {
        if (ch === "\r" || ch === "\n") {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.off("data", onData);
          process.stdout.write("\n");
          return resolve(value);
        }
        if (ch === "\u0003") process.exit(1);
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else value += ch;
      }
    };
    process.stdin.on("data", onData);
  });
}

const pw = await ask("Password: ");
if (pw.length < 10) {
  console.error("Use at least 10 characters.");
  process.exit(1);
}
const hash = await bcrypt.hash(pw, 12);
console.log(`\nACCOUNT_PASSWORD_HASH='${hash}'`);
