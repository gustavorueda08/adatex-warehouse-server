"use strict";

module.exports = {
  routes: [
    {
      method: "POST",
      path: "/demand-forecasts/trigger",
      handler: "custom-demand-forecast.triggerCalculation",
      config: {
        policies: [],
      },
    },
    {
      method: "GET",
      path: "/demand-forecasts/purchase-suggestions",
      handler: "custom-demand-forecast.purchaseSuggestions",
      config: {
        policies: [],
      },
    },
  ],
};
