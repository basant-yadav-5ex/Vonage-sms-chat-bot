import dotenv from "dotenv";
dotenv.config();

import { sendSms } from "./vonageSend.js";
import { waitForInboundFrom, waitForDlrById } from "./server.js";

function assertContains(actual, expected) {
  if (!actual.toLowerCase().includes(expected.toLowerCase())) {
    throw new Error(`Expected reply to contain "${expected}". Got: "${actual}"`);
  }
}

async function main() {
  const botNumber = process.env.BOT_TO;        // 18337117141
  const yourVonage = process.env.VONAGE_FROM;  // 18332245468

  if (!botNumber) throw new Error("Missing BOT_TO in .env");
  if (!yourVonage) throw new Error("Missing VONAGE_FROM in .env");

  console.log("1) Sending to bot...");
  const sendRes = await sendSms({ to: botNumber, text: "Hello" });
  console.log("SEND RESPONSE:", JSON.stringify(sendRes, null, 2));

  const first = sendRes?.messages?.[0];
  if (!first) throw new Error("Unexpected send response: no messages[0]");
  if (first.status !== "0") {
    throw new Error(`Vonage send failed immediately. status=${first.status} error=${first["error-text"] || "unknown"}`);
  }

  const outboundId = first["message-id"] || first.messageId;
  console.log("Outbound message-id:", outboundId);

  // ✅ PRIMARY VALIDATION: bot reply arrives inbound FROM botNumber
  console.log("2) Waiting for bot reply inbound...");
  const inbound = await waitForInboundFrom({ fromNumber: botNumber, timeoutMs: 30000 });

  const replyText = inbound.text || "";
  console.log("BOT REPLY:", replyText);

  // ✅ Your validation rule (adjust as needed)
  assertContains(replyText, "AIVA");

  console.log("✅ PASS: Bot reply received + validated");

  // (Optional) Secondary validation: DLR
  // Don't fail the test if DLR doesn't arrive; just log it.
  try {
    console.log("3) Waiting for DLR (optional)...");
    const dlr = await waitForDlrById(outboundId, 45000);
    console.log("DLR RECEIVED:", JSON.stringify(dlr, null, 2));
  } catch (e) {
    console.log("⚠️ DLR not received in time (continuing):", e.message);
  }
}

main().catch((e) => {
  console.error("❌ FAIL:", e.message);
  process.exit(1);
});
