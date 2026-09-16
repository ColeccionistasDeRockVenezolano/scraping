#!/usr/bin/env node
import { randomBytes, scrypt as scryptCallback } from "node:crypto";

async function readPassword() {
  if (!process.stdin.isTTY) {
    let value = "";
    process.stdin.setEncoding("utf8");
    for await (const chunk of process.stdin) value += chunk;
    return value.replace(/[\r\n]+$/u, "");
  }

  process.stderr.write("Contraseña (no se mostrará): ");
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf8");
  return new Promise((resolve, reject) => {
    let value = "";
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stderr.write("\n");
    };
    process.stdin.on("data", (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish();
          reject(new Error("cancelado"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    });
  });
}

const password = await readPassword();
if (password.length < 12 || password.length > 200) {
  console.error("La contraseña debe tener entre 12 y 200 caracteres.");
  process.exitCode = 1;
} else {
  const N = 16_384;
  const r = 8;
  const p = 1;
  const salt = randomBytes(16);
  const derived = await new Promise((resolve, reject) => {
    scryptCallback(password, salt, 64, { N, r, p, maxmem: 64 * 1024 * 1024 }, (error, result) => {
      if (error) reject(error); else resolve(result);
    });
  });
  process.stdout.write(`scrypt$${N}$${r}$${p}$${salt.toString("base64url")}$${derived.toString("base64url")}\n`);
}
