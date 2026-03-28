module.exports = {
  /**
   * Cron job para verificar y enviar listas de empaque pendientes.
   * Se ejecuta cada 20 minutos para dar tiempo suficiente a revisión en Siigo.
   */
  // "*/20 * * * *": async ({ strapi }) => {
  //   await strapi
  //     .service("api::order.packing-list-notifier")
  //     .processPendingOrders();
  // },

  /**
   * Cron job para calcular métricas de ventas y retención mensuales de los clientes.
   * Se ejecuta cada día a la 1:00 AM.
   */
  "0 1 * * *": async ({ strapi }) => {
    await strapi
      .service("api::customer.customer")
      .calculateAnalytics();
  },

  /**
   * Cron job para calcular predicciones de demanda por cliente × producto.
   * Se ejecuta cada día a las 2:00 AM (después de analytics).
   */
  "0 2 * * *": async ({ strapi }) => {
    await strapi
      .service("api::demand-forecast.demand-forecast")
      .calculateForecasts();
  },
};
