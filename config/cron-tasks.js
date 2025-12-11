module.exports = {
  /**
   * Cron job para verificar y enviar listas de empaque pendientes.
   * Se ejecuta cada 5 minutos para dar tiempo suficiente a revisión en Siigo.
   */
  "*/5 * * * *": async ({ strapi }) => {
    await strapi
      .service("api::order.packing-list-notifier")
      .processPendingOrders();
  },
};
