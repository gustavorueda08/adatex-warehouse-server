const strapi = require('@strapi/strapi');

strapi().start().then(async app => {
  const service = app.service('api::customer.customer');
  
  const orders = await app.entityService.findMany('api::order.order', {
    filters: {
      type: 'sale',
      state: { $in: ['completed', 'processing'] }
    },
    limit: 5,
    sort: 'createdDate:desc',
    populate: ['customer']
  });
  
  console.log("Recent 5 sales orders dates:", orders.map(o => ({
    id: o.id,
    createdAt: o.createdAt,
    createdDate: o.createdDate,
    completedDate: o.completedDate,
    actualDispatchDate: o.actualDispatchDate,
    siigoId: o.siigoId,
    customer: o.customer?.id
  })));
  
  console.log("Running analytics...");
  await service.calculateAnalytics();
  console.log("Analytics calculated");
  process.exit(0);
}).catch(e => {
  console.error(e);
  process.exit(1);
});
