'use strict';

module.exports = {
  routes: [
    {
      method: 'GET',
      path: '/items/aggregate',
      handler: 'item.aggregate',
      config: { auth: false },
    },
  ],
};
