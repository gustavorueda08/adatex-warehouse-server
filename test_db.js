const strapi = require('@strapi/strapi');
strapi().start().then(async (app) => {
  const orders = await app.entityService.findMany('api::order.order', {
    filters: { state: 'completed' },
    sort: { updatedAt: 'desc' },
    limit: 5,
    populate: ['attachments', 'customer', 'customer.seller']
  });
  console.log(JSON.stringify(orders.map(o => ({
    id: o.id,
    code: o.code,
    type: o.type,
    updatedAt: o.updatedAt,
    siigoIdTypeA: o.siigoIdTypeA,
    siigoIdTypeB: o.siigoIdTypeB,
    invoiceNumberTypeA: o.invoiceNumberTypeA,
    hasAttachments: o.attachments?.length > 0
  })), null, 2));
  process.exit(0);
});
