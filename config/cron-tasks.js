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
};
