import http from "node:http";
import { execFile } from "node:child_process";

const PORT = process.env.NOTIFY_PORT || 7777;
const HOST = "0.0.0.0";

const NOTIFICATION_MESSAGES = {
  permission_prompt: "Claude Code is waiting for permission",
  idle_prompt: "Claude Code is idle and waiting for input",
  elicitation_dialog: "Claude Code needs your input",
};

const server = http.createServer((req, res) => {
  if (req.method !== "POST") {
    res.writeHead(404);
    return res.end();
  }

  const MAX_BODY_SIZE = 1024 * 1024; // 1 MB
  let body = "";
  let aborted = false;

  req.on("data", (chunk) => {
    body += chunk.toString();
    if (body.length > MAX_BODY_SIZE) {
      aborted = true;
      res.writeHead(413, { "Content-Type": "text/plain" });
      res.end("Payload too large");
      req.destroy();
    }
  });

  req.on("end", () => {
    if (aborted) return;
    let title = "Claude Code";
    let message = "Claude Code needs attention";

    try {
      const data = JSON.parse(body);

      if (typeof data.title === "string") {
        title = data.title;
      }

      if (
        typeof data.notification_type === "string" &&
        NOTIFICATION_MESSAGES[data.notification_type]
      ) {
        message = NOTIFICATION_MESSAGES[data.notification_type];
      } else if (typeof data.message === "string") {
        message = data.message;
      }
    } catch {
      // Use default message if JSON parsing fails
    }

    // Truncate and strip control characters before passing to terminal-notifier
    const sanitize = (str, max) =>
      str.slice(0, max).replace(/[\x00-\x1f\x7f]/g, "");

    execFile("terminal-notifier", [
      "-title",
      sanitize(title, 100),
      "-message",
      sanitize(message, 200),
      "-sound",
      "default",
    ]);

    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("ok");
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Webhook listening on http://${HOST}:${PORT}`);
});
