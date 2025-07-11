import { prismaClient } from "..";
import { redis } from "../cache/redis";
import { HEARTBEAT, NEW_TASK, PONG, REGISTER_WORKER, REGISTRATION_SUCCESS, TASK_RESULT, WORKER_PING } from "../messages";

export class User {
  public socket: WebSocket;
  public publicKey: string;
  public lastActive: number;
  public disconnectTimeout?: NodeJS.Timeout;
  public isAvailable: boolean = true;
  public isWorker: boolean = false;

  constructor(socket: WebSocket, publicKey: string) {
    this.socket = socket;
    this.publicKey = publicKey;
    this.lastActive = Date.now();
  }
}

type MessageType = "CONNECTED" | "WELCOME" | "HEARTBEAT" | "REGISTER_WORKER" | "WORKER_PING" | "TASK_RESULT" | "NEW_TASK";

export interface MessageData {
  type: MessageType;
  payload?: any;
}

class SocketManager {
  private users: User[] = [];
  private HEARTBEAT_INTERVAL = 10_000;
  private GRACE_PERIOD = 15_000;
  public static instance: SocketManager;
  private jobSchedulerRunning = false;

  constructor() {
    this.users = [];
    this.startHeartbeatCheck();
    this.startJobScheduler();
  }

  public static getInstance(): SocketManager {
    if (!SocketManager.instance) {
      SocketManager.instance = new SocketManager();
    }
    return SocketManager.instance;
  }

  // 🔥 USER METHODS
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

        switch (data.type) {
          case HEARTBEAT:
            user.socket.send(JSON.stringify({ type: "HEARTBEAT" }));
            break;

          case REGISTER_WORKER:
            this.handleWorkerRegistration(user, data.payload);
            break;

          case WORKER_PING:
            this.handleWorkerPing(user, data.payload);
            break;

          case TASK_RESULT:
            this.handleTaskResult(user, data.payload);
            break;
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

  // 🔥 JOB SCHEDULER METHODS
  private async startJobScheduler() {
    if (this.jobSchedulerRunning) return;

    this.jobSchedulerRunning = true;
    console.log("Job Scheduler started within WebSocket server...");

    this.processJobQueue();
  }

  private async processJobQueue() {
    while (this.jobSchedulerRunning) {
      try {
        // Check for jobs in Redis queue
        const job = await redis.brpop(process.env.REDIS_JOB_QUEUE ?? "job_queue", 1);

        if (job) {
          const jobData = JSON.parse(job[1]);
          console.log("Processing job:", jobData);

          if (jobData.type === "uptime_check") {
            await this.handleUptimeCheck(jobData.taskId);
          }
        }
      } catch (error) {
        console.error("Job scheduler error:", error);
        await this.sleep(5000);
      }
    }
  }

  private handleWorkerRegistration(user: User, payload: any) {
    const { deviceInfo } = payload;

    user.isWorker = true;
    user.isAvailable = true;

    console.log(`Worker registered: ${user.publicKey}`);

    user.socket.send(JSON.stringify({
      type: REGISTRATION_SUCCESS,
      payload: {
        workerId: user.publicKey,
        message: "Successfully registered as worker"
      }
    }));
  }

  private async handleUptimeCheck(taskId: string) {
    try {
      const taskData = await redis.get(`task:${taskId}`);
      if (!taskData) {
        console.error("Task not found in Redis:", taskId);
        return;
      }

      const task = JSON.parse(taskData);

      await prismaClient.task.update({
        where: { id: taskId },
        data: { status: "active" }
      });

      const availableWorkers = this.users.filter(user =>
        user.isWorker && user.isAvailable
      ).slice(0, task.maxResponses);

      if (availableWorkers.length === 0) {
        console.log("No available workers, requeueing task");
        // Requeue with delay
        setTimeout(async () => {
          await redis.lpush("job_queue", JSON.stringify({
            taskId: task.id,
            type: "uptime_check",
            priority: "normal",
            retryCount: 1,
            createdAt: new Date().toISOString()
          }));
        }, 5000);
        return;
      }

      console.log(`Distributing task ${task.id} to ${availableWorkers.length} workers`);

      for (const worker of availableWorkers) {
        const subtask = {
          id: `${task.id}_${worker.publicKey}`,
          taskId: task.id,
          url: task.url,
          type: "uptime_check",
          assignedTo: worker.publicKey,
          status: "assigned",
          createdAt: new Date().toISOString(),
          timeout: 30000
        };

        await redis.set(`subtask:${subtask.id}`, JSON.stringify(subtask));

        worker.socket.send(JSON.stringify({
          type: NEW_TASK,
          payload: subtask
        }));

        // Mark worker as unavailable
        worker.isAvailable = false;

        console.log(`Task assigned to worker: ${worker.publicKey}`);
      }
    } catch (error) {
      console.error("Error handling uptime check:", error);

      // Update task status
      await prismaClient.task.update({
        where: { id: taskId },
        data: { status: "failed" }
      });
    }
  }

  private async handleTaskResult(user: User, payload: any) {
    const { subtaskId, result } = payload;

    try {
      // Get subtask details
      const subtaskData = await redis.get(`subtask:${subtaskId}`);
      if (!subtaskData) {
        console.error("Subtask not found:", subtaskId);
        return;
      }

      const subtask = JSON.parse(subtaskData);

      // Store result in database
      // await prismaClient.taskResult.create({
      //   data: {
      //     taskId: subtask.taskId,
      //     workerId: user.publicKey,
      //     result: JSON.stringify(result),
      //     status: result.success ? "completed" : "failed",
      //     submittedAt: new Date()
      //   }
      // });

      // Mark worker as available again
      user.isAvailable = true;

      // Push to verification queue
      await redis.lpush("verification_queue", JSON.stringify({
        taskId: subtask.taskId,
        subtaskId: subtaskId,
        result,
        workerId: user.publicKey
      }));

      console.log(`Result received from worker ${user.publicKey} for task ${subtask.taskId}`);

      // Send acknowledgment back to worker
      user.socket.send(JSON.stringify({
        type: "TASK_RESULT_ACK",
        payload: {
          subtaskId: subtaskId,
          status: "received"
        }
      }));

    } catch (error) {
      console.error("Error handling task result:", error);

      // Send error response to worker
      user.socket.send(JSON.stringify({
        type: "TASK_RESULT_ERROR",
        payload: {
          subtaskId: subtaskId,
          error: "Failed to process result"
        }
      }));
    }
  }

  private handleWorkerPing(user: User, payload: any) {
    const { isAvailable } = payload;

    if (user.isWorker) {
      user.isAvailable = isAvailable;
      user.lastActive = Date.now();
    }

    user.socket.send(JSON.stringify({
      type: PONG,
      payload: { timestamp: new Date().toISOString() }
    }));
  }

  // 🔥 UTILITY METHODS
  private sleep(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
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

  // 🔥 DEBUG METHODS
  public getConnectedWorkers() {
    return this.users
      .filter(user => user.isWorker)
      .map(user => ({
        publicKey: user.publicKey,
        isAvailable: user.isAvailable,
        lastActive: new Date(user.lastActive).toISOString()
      }));
  }

  public getStats() {
    const totalUsers = this.users.length;
    const totalWorkers = this.users.filter(u => u.isWorker).length;
    const availableWorkers = this.users.filter(u => u.isWorker && u.isAvailable).length;

    return {
      totalUsers,
      totalWorkers,
      availableWorkers,
      jobSchedulerRunning: this.jobSchedulerRunning
    };
  }

  public stopJobScheduler() {
    this.jobSchedulerRunning = false;
    console.log("Job Scheduler stopped");
  }
}

export default SocketManager.getInstance();
