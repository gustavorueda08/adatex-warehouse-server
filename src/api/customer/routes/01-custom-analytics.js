module.exports = {
  routes: [
    {
      method: "POST",
      path: "/customers/trigger-analytics",
      handler: "api::customer.customer.triggerAnalytics",
      config: {
        auth: false,
      },
    },
  ],
};
