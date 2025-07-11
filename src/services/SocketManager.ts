export class User {
  public socket: WebSocket;
  public publicKey: string;
  public lastActive: number;
  public disconnectTimeout?: NodeJS.Timeout;

  constructor(socket: WebSocket, publicKey: string) {
    this.socket = socket;
    this.publicKey = publicKey;
    this.lastActive = Date.now();
  }
}

type MessageType = "CONNECTED" | "WELCOME" | "HEARTBEAT";

export interface MessageData {
  type: MessageType;
  payload?: any;
}

class SocketManager {
  private users: User[] = [];
  private HEARTBEAT_INTERVAL = 10_000;
  private GRACE_PERIOD = 15_000;
  public static instance: SocketManager;

  constructor() {
    this.users = [];
    this.startHeartbeatCheck();
  }

  public static getInstance(): SocketManager {
    if (!SocketManager.instance) {
      SocketManager.instance = new SocketManager();
    }
    return SocketManager.instance;
  }

  async addUser(user: User) {
    const existing = this.users.find((u) => u.publicKey === user.publicKey);

    if (existing) {
      if (existing.disconnectTimeout) {
        clearTimeout(existing.disconnectTimeout); // Cancel pending removal
      }
      existing.socket.close(); // Close the old one
      this.users = this.users.filter((u) => u.publicKey !== user.publicKey);
    }

    this.users.push(user);
    this.userHandler(user);

    // Optionally send WELCOME or CONNECTED
    user.socket.send(JSON.stringify({ type: "WELCOME" }));
  }

  removeUser(userSocket: WebSocket) {
    const user = this.users.find((u) => u.socket === userSocket);
    if (!user) return;
    this.users = this.users.filter((u) => u.socket !== userSocket);
  }

  private userHandler(user: User) {
    const { socket } = user;

    socket.onmessage = (message: MessageEvent) => {
      try {
        const data: MessageData = JSON.parse(message.data);
        user.lastActive = Date.now();

        if (data.type === "HEARTBEAT") {
          // Optionally echo or log
          user.socket.send(JSON.stringify({ type: "HEARTBEAT" }));
        }
      } catch (err) {
        console.error("Invalid message", err);
      }
    };

    socket.onclose = () => {
      // Don't remove user immediately
      user.disconnectTimeout = setTimeout(() => {
        this.removeUser(socket);
        console.log(`User ${user.publicKey} disconnected after grace period.`);
      }, this.GRACE_PERIOD);
    };

    socket.onerror = (err) => {
      console.error("Socket error", err);
    };
  }

  private startHeartbeatCheck() {
    setInterval(() => {
      const now = Date.now();
      for (const user of this.users) {
        if (now - user.lastActive > this.HEARTBEAT_INTERVAL + this.GRACE_PERIOD) {
          console.log(`Removing inactive user: ${user.publicKey}`);
          user.socket.close(); // Force close
          this.removeUser(user.socket);
        }
      }
    }, this.HEARTBEAT_INTERVAL);
  }
}

export default SocketManager.getInstance();
