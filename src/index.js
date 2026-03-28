"use strict";

module.exports = {
  register() {},

  bootstrap({ strapi }) {
    const { Server } = require("socket.io");

    // Allowed origins for Socket.io — mirrors the CORS list in config/middlewares.js.
    // Add CORS_ADDITIONAL_ORIGINS (comma-separated) in .env to extend without code changes.
    const corsOrigins = [
      "http://localhost:3000",
      "https://www.adatex.com.co",
      "https://adatex.com.co",
      "https://adatex-warehouse-server-production.up.railway.app",
      ...(process.env.CORS_ADDITIONAL_ORIGINS
        ? process.env.CORS_ADDITIONAL_ORIGINS.split(",").map((o) => o.trim())
        : []),
    ];

    const io = new Server(strapi.server.httpServer, {
      cors: {
        origin: corsOrigins,
        methods: ["GET", "POST"],
        credentials: true,
      },
    });

    strapi.io = io;

    // Require a valid JWT on every socket connection
    io.use(async (socket, next) => {
      try {
        const authHeader = socket.handshake?.headers?.authorization || "";
        const tokenFromHeader = authHeader.startsWith("Bearer ")
          ? authHeader.slice(7)
          : null;

        const token =
          socket.handshake?.auth?.token || // { token: "..." } in CONNECT payload
          socket.handshake?.query?.token || // ?token=...
          tokenFromHeader; // Authorization: Bearer ...

        if (!token) return next(new Error("Unauthorized"));

        const jwtService = strapi.plugins["users-permissions"].services.jwt;
        const payload = await jwtService.verify(token);

        if (!payload?.id) return next(new Error("Unauthorized"));

        socket.data = socket.data || {};
        socket.data.user = { id: payload.id };

        return next();
      } catch {
        return next(new Error("Unauthorized"));
      }
    });

    io.on("connection", (socket) => {
      const userId = socket?.data?.user?.id;
      if (!userId) {
        socket.disconnect(true);
        return;
      }

      strapi.log.info(`Socket connected: user=${userId} socket=${socket.id}`);

      // Join a personal room so the server can push user-specific events
      socket.join(`user:${userId}`);

      // Rooms scoped to a specific order (used for real-time order updates)
      socket.on("join:order", (orderId) => socket.join(`order:${orderId}`));
      socket.on("leave:order", (orderId) => socket.leave(`order:${orderId}`));

      socket.on("disconnect", () => {
        strapi.log.info(`Socket disconnected: user=${userId}`);
      });
    });
  },
};
