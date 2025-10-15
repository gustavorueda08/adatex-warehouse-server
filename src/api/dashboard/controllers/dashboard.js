"use strict";

const logger = require("../../../utils/logger");
const moment = require("moment-timezone");

module.exports = {
  /**
   * GET /api/dashboard/stats
   * Obtiene todas las estadísticas del dashboard
   */
  async getStats(ctx) {
    try {
      const dashboardService = strapi.service("api::dashboard.dashboard");
      const data = await dashboardService.getDashboardStats();
      const response = {
        data,
        meta: {
          timestamp: moment().toDate(),
        },
      };
      console.log(response);

      return response;
    } catch (error) {
      logger.error("Error al obtener estadísticas del dashboard:", error);
      return ctx.internalServerError(error.message, {
        error: {
          status: 500,
          name: "DashboardError",
          message:
            error.message || "Error al obtener estadísticas del dashboard",
          details: process.env.NODE_ENV !== "production" ? error : undefined,
        },
      });
    }
  },
};
