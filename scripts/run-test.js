const strapi = require('@strapi/strapi');

async function run() {
  const app = await strapi().load();
  await app.start();

  try {
    console.log('Creating parent product...');
    const parentProd = await app.entityService.create('api::product.product', {
      data: {
        name: 'Tela Paris Test AutoCut 5',
        unit: 'kg',
        type: 'variableQuantityPerItem',
        canCut: true,
        cutUnit: 'm',
        cutTransformationFactor: 2.5,
        category: 'Confeccion',
        isActive: true
      }
    });

    console.log('Parent product created:', parentProd.id);

    await new Promise(r => setTimeout(r, 2000));

    console.log('Searching for auto-generated child product...');
    const childProds = await app.entityService.findMany('api::product.product', {
      filters: { parentProduct: parentProd.id },
      populate: ['transformationFactor']
    });

    console.log('Child products found:', JSON.stringify(childProds, null, 2));

  } catch (err) {
    console.error('Error during test:', err.message);
  } finally {
    await app.destroy();
    process.exit(0);
  }
}

run();
