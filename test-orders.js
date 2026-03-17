const strapi = require('@strapi/strapi');
strapi({ distDir: './dist' }).start().then(async app => {
  const orders = await app.entityService.findMany('api::order.order', {
    filters: {
      type: 'sale',
      state: 'completed'
    },
    limit: 5,
    sort: 'createdDate:desc',
    populate: ['customer', 'orderProducts', 'orderProducts.product']
  });
  console.log(JSON.stringify(orders, null, 2));
  process.exit(0);
});
