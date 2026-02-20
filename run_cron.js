const strapi = require('@strapi/strapi');
strapi().start().then(async (app) => {
  try {
    const svc = app.service('api::order.packing-list-notifier');
    if (!svc) {
      console.log('Servicio api::order.packing-list-notifier no encontrado');
    } else {
      console.log('Iniciando proceso manual...');
      await svc.processPendingOrders();
      console.log('Proceso terminado');
    }
  } catch (err) {
    console.error('Error:', err);
  } finally {
    process.exit(0);
  }
});
