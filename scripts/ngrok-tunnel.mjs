import net from "net";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(__dirname, "..");
const ngrokName = process.platform === "win32" ? "ngrok.exe" : "ngrok";
const ngrokBin = path.join(projectRoot, ngrokName);

const port = Number(process.env.PORT || 3000);

function waitForLocalPort(p, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tryConnect = () => {
      const socket = net.createConnection({ port: p, host: "127.0.0.1" }, () => {
        socket.end();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Nothing listening on 127.0.0.1:${p} after ${timeoutMs}ms`));
        } else {
          setTimeout(tryConnect, 250);
        }
      });
    };
    tryConnect();
  });
}

async function printWebhookHintsFromLocalApi() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch("http://127.0.0.1:4040/api/tunnels");
      if (!r.ok) throw new Error(String(r.status));
      const j = await r.json();
      const https = j.tunnels?.find((t) => t.proto === "https");
      const pub = https?.public_url;
      if (pub) {
        const base = String(pub).replace(/\/$/, "");
        console.log("");
        console.log("Use this base URL for Vonage webhooks:");
        console.log("  Inbound SMS: ", `${base}/api/vonage/inbound-sms`);
        console.log("  DLR:         ", `${base}/sms/status`);
        console.log("  Web UI:      ", `${base}/`);
        console.log("");
        return;
      }
    } catch {
      /* ngrok local API not ready yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

if (!fs.existsSync(ngrokBin)) {
  console.error(`Missing ${ngrokName} in project root:\n  ${ngrokBin}`);
  process.exit(1);
}

if (!(process.env.NGROK_AUTHTOKEN || "").trim()) {
  console.warn(
    "NGROK_AUTHTOKEN not set in .env — ngrok will use your saved config if you ran: ngrok config add-authtoken …"
  );
}

try {
  console.log(`Waiting for local server on port ${port}…`);
  await waitForLocalPort(port);

  console.log(`Starting ${ngrokName} http ${port} …\n`);

  const child = spawn(ngrokBin, ["http", String(port)], {
    cwd: projectRoot,
    stdio: "inherit",
    env: process.env
  });

  child.on("error", (err) => {
    console.error("Failed to start ngrok:", err.message);
    process.exit(1);
  });

  child.on("exit", (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code === null ? 1 : code);
  });

  setTimeout(() => {
    printWebhookHintsFromLocalApi().catch(() => {});
  }, 1200);
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
