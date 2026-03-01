module.exports = async ({ strapi }) => {
  try {
    console.log("Creating parent product...");
    const parentProd = await strapi.entityService.create(
      "api::product.product",
      {
        data: {
          name: "Tela Paris Test AutoCut 3",
          unit: "kg",
          type: "variableQuantityPerItem",
          canCut: true,
          cutUnit: "m",
          cutTransformationFactor: 2.5,
          category: "Confeccion",
          isActive: true,
        },
      },
    );

    console.log("Parent product created:", parentProd.id);

    // Wait a brief moment to ensure hooks finish (although they are awaited, sometimes async nested triggers need time)
    await new Promise((r) => setTimeout(r, 1000));

    console.log("Searching for auto-generated child product...");
    const childProds = await strapi.entityService.findMany(
      "api::product.product",
      {
        filters: { parentProduct: parentProd.id },
        populate: ["transformationFactor"],
      },
    );

    console.log("Child products found:", JSON.stringify(childProds, null, 2));
  } catch (err) {
    console.error("Error during test:", err.message);
  }
};
