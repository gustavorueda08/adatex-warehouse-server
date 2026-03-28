"use strict";

module.exports = {
  async triggerCalculation(ctx) {
    try {
      await strapi
        .service("api::demand-forecast.demand-forecast")
        .calculateForecasts();
      ctx.body = { success: true };
    } catch (error) {
      strapi.log.error("[DemandForecast] Trigger error:", error);
      ctx.throw(500, "Error calculating demand forecasts");
    }
  },

  async purchaseSuggestions(ctx) {
    try {
      const suggestions = await strapi
        .service("api::demand-forecast.demand-forecast")
        .getPurchaseSuggestions();
      ctx.body = { data: suggestions };
    } catch (error) {
      strapi.log.error("[DemandForecast] Purchase suggestions error:", error);
      ctx.throw(500, "Error generating purchase suggestions");
    }
  },
};
