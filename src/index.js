"use strict";

module.exports = {
  register() {},

  bootstrap({ strapi }) {
    const { Server } = require("socket.io");
    // const { createAdapter } = require("@socket.io/redis-adapter");
    // const { createClient } = require("redis");

    const io = new Server(strapi.server.httpServer, {
      cors: {
        origin: ["http://localhost:3000", "https://tu-dominio.com"],
        methods: ["GET", "POST"],
        credentials: true,
      },
      // path: "/realtime", // opcional
    });

    strapi.io = io;

    // 🔐 Auth obligatorio
    io.use(async (socket, next) => {
      try {
        const authHeader = socket.handshake?.headers?.authorization || "";
        const tokenFromHeader = authHeader.startsWith("Bearer ")
          ? authHeader.slice(7)
          : null;

        const token =
          socket.handshake?.auth?.token || // 40{"token":"..."} en CONNECT
          socket.handshake?.query?.token || // ?token=...
          tokenFromHeader; // Authorization: Bearer ...

        if (!token) return next(new Error("Unauthorized"));

        // users-permissions JWT
        const jwtService = strapi.plugins["users-permissions"].services.jwt;

        // ✅ Si verify es async en tu build, este await es necesario.
        //    Si es sync, no pasa nada por dejar el await.
        const payload = await jwtService.verify(token);

        if (!payload || !payload.id) {
          return next(new Error("Unauthorized"));
        }

        socket.data = socket.data || {};
        socket.data.user = { id: payload.id };

        return next();
      } catch (err) {
        return next(new Error("Unauthorized"));
      }
    });

    io.on("connection", (socket) => {
      const userId = socket?.data?.user?.id;
      if (!userId) {
        socket.disconnect(true);
        return;
      }

      console.log("Usuario conectado:", userId, socket.id);

      // Sala personal
      socket.join(`user:${userId}`);

      // 👉 Si MÁS ADELANTE haces I/O aquí, vuelve el handler async:
      socket.on("join:order", (orderId) => {
        socket.join(`order:${orderId}`);
      });

      socket.on("leave:order", (orderId) => {
        socket.leave(`order:${orderId}`);
      });

      socket.on("disconnect", () => {
        console.log("Usuario desconectado:", userId);
      });
    });
  },
};
