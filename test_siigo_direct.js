const strapi = require('@strapi/strapi');

async function test() {
  const app = await strapi().load();
  await app.start();

  try {
    const authService = app.service('api::siigo.auth');
    const apiUrl = process.env.SIIGO_API_URL || "https://api.siigo.com";
    
    console.log("Fetching by code RI-NAVY-01");
    const response = await authService.authenticatedFetch(
          `${apiUrl}/v1/products?code=RI-NAVY-01`,
          {
            method: "GET",
          },
        );
    const data = await response.json();
    console.log('Direct code search data:', JSON.stringify(data, null, 2));

  } catch (e) {
    console.error(e);
  }

  process.exit(0);
}

test();
