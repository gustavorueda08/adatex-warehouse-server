module.exports = {
  routes: [
    {
      method: "GET",
      path: "/dashboard/stats",
      handler: "dashboard.getStats",
      config: {
        policies: [],
        middlewares: [],
      },
    },
  ],
};
