import { PublicKey } from "@solana/web3.js";
import "dotenv/config";
import { parse } from "url";
import { WebSocketServer } from "ws";
import { PrismaClient } from "./generated/prisma";
import socketManager, { User } from "./services/SocketManager";
import { redis } from "./cache/redis";

const PORT = Number(process.env.PORT) || 3000;

const wss = new WebSocketServer({ port: PORT, host: "0.0.0.0" });
export const prismaClient = new PrismaClient();

wss.on("connection", (ws: WebSocket, req) => {
  try {
    const { query } = parse(req.url || "", true);
    const pk = typeof query.publicKey === "string" ? query.publicKey : "";

    if (!pk) {
      ws.close(1008, "Missing publicKey");
      console.warn("Connection rejected: Missing publicKey");
      return;
    }

    let publicKey: PublicKey;
    try {
      publicKey = new PublicKey(pk);
    } catch (err) {
      ws.close(1008, "Invalid publicKey");
      console.warn("Connection rejected: Invalid publicKey", err);
      return;
    }

    const user = new User(ws, publicKey.toBase58());
    socketManager.addUser(user);
  } catch (err) {
    try {
      ws.close(1011, "Internal server error");
    } catch (_) { }
  }
});

console.log(`LISTENING ON PORT ${PORT}`);
