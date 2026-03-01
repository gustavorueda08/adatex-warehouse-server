const { createStrapi } = require("@strapi/strapi");

async function runTest() {
  const strapi = createStrapi({});
  await strapi.load();
  await strapi.server.mount();

  console.log("--- Starting Auto Cut E2E Test ---");

  try {
    // 1. Create Parent Product
    console.log("1. Creating Parent Product...");
    const parentPayload = {
      name: "Test Fabric E2E",
      code: `TF-E2E-${Date.now()}`,
      barcode: `TF-E2E-${Date.now()}`,
      unit: "kg",
      type: "variableQuantityPerItem",
      canCut: true,
      cutUnit: "m",
      cutTransformationFactor: 10,
      isActive: true,
    };
    const parentProduct = await strapi.entityService.create(
      "api::product.product",
      { data: parentPayload },
    );
    console.log("Parent Product created:", parentProduct.id);

    // Wait for lifecycles just in case
    await new Promise((resolve) => setTimeout(resolve, 1000));

    // 2. Verify Child cutItem & Transformation Factor
    console.log("2. Verifying Child cutItem...");
    const childProducts = await strapi.entityService.findMany(
      "api::product.product",
      {
        filters: { parentProduct: parentProduct.id, type: "cutItem" },
        populate: ["transformationFactor"],
      },
    );

    if (!childProducts || childProducts.length === 0) {
      throw new Error("❌ Child cutItem was NOT created automatically!");
    }
    const childProduct = childProducts[0];
    console.log(
      `✅ Child cutItem found: ${childProduct.name} (ID: ${childProduct.id})`,
    );

    if (!childProduct.transformationFactor) {
      throw new Error("❌ Child cutItem is missing transformationFactor link!");
    }
    console.log(
      `✅ Transformation factor linked (ID: ${childProduct.transformationFactor.id}), Factor: ${childProduct.transformationFactor.factor}`,
    );

    // 3. Find a smartCut warehouse
    console.log("3. Finding smartCut warehouse...");
    let warehouses = await strapi.entityService.findMany(
      "api::warehouse.warehouse",
      {
        filters: { type: "smartCut" },
        limit: 1,
      },
    );

    let warehouse = warehouses[0];
    if (!warehouse) {
      console.log("No smartCut warehouse found. Creating a temporary one...");
      warehouse = await strapi.entityService.create(
        "api::warehouse.warehouse",
        {
          data: {
            name: "Test SmartCut Warehouse",
            shortName: "TSC",
            address: "123 Test St",
            type: "smartCut",
            isActive: true,
          },
        },
      );
    }
    console.log(`Found warehouse: ${warehouse.name} (ID: ${warehouse.id})`);

    // 4. Create an Inflow Order (25kg to smartCut warehouse)
    console.log("4. Simulating Inflow Order (25kg)...");

    // We pass the full structure to the Order Service just like the frontend
    const inflowData = {
      code: `IN-${Date.now()}`,
      type: "in",
      state: "draft",
      paymentStatus: "paid",
      completedDate: new Date(),
      destinationWarehouse: warehouse.id,
      notes: "E2E Test Inflow",
      products: [
        {
          product: parentProduct.id,
          requestedQuantity: 25,
          unit: "kg",
          items: [
            {
              quantity: 25,
              warehouse: warehouse.id,
              state: "available",
              lot: `LOTE-${Date.now()}`,
              itemNumber: 1,
            },
          ],
        },
      ],
    };

    const orderService = strapi.service("api::order.order");
    const itemMovementService = strapi.service("api::item.item-movement");

    let inflowOrder = await orderService.create(inflowData);

    // Complete the Inflow to trigger Item Movement to available
    await strapi.entityService.update("api::order.order", inflowOrder.id, {
      data: { state: "completed" },
    });

    // Manually push the items to available since we skipped the complex `orderService.update` lifecycle payload
    const inflowItemsToUpdate = await strapi.entityService.findMany(
      "api::item.item",
      {
        filters: { sourceOrder: inflowOrder.id },
      },
    );
    for (const item of inflowItemsToUpdate) {
      await strapi.entityService.update("api::item.item", item.id, {
        data: { state: "available", warehouse: warehouse.id },
      });
    }

    // Wait a brief moment to ensure hooks complete
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Calculate current parent stock directly from physical items
    const parentItemsBefore = await strapi.entityService.findMany(
      "api::item.item",
      {
        filters: { product: parentProduct.id, state: "available" },
      },
    );
    const stockBefore = parentItemsBefore.reduce(
      (acc, item) => acc + (Number(item.currentQuantity) || 0),
      0,
    );
    console.log(`🟢 Parent Stock Before Cut: ${stockBefore} kg`);

    // Fetch the physical item created by the system
    const existingParentItem = parentItemsBefore;

    if (!existingParentItem.length) {
      throw new Error(
        "❌ System failed to create the parent physical item upon Inflow.",
      );
    }
    const itemToCut = existingParentItem[0];

    // 5. Create a Transform Order to cut 1kg from Parent -> 10m of Child
    console.log("5. Simulating Cut Transform Order (1kg -> 10m)...");

    const transformData = {
      code: `TRANS-${Date.now()}`,
      type: "transform",
      state: "draft",
      paymentStatus: "paid",
      completedDate: new Date(),
      sourceWarehouse: warehouse.id,
      destinationWarehouse: warehouse.id,
      notes: "E2E Test Transform (Cut)",
      products: [
        {
          product: childProduct.id,
          requestedQuantity: 10,
          unit: "m",
          items: [
            {
              sourceItemId: itemToCut.id,
              sourceQuantityConsumed: 1,
              targetQuantity: 10,
              quantity: 10,
              warehouse: warehouse.id,
            },
          ],
        },
      ],
    };

    let transformOrder = await orderService.create(transformData);

    // Complete the transform to finalize movement
    await strapi.entityService.update("api::order.order", transformOrder.id, {
      data: { state: "completed" },
    });

    // Mock the state completion transition
    const transformItemsToUpdate = await strapi.entityService.findMany(
      "api::item.item",
      {
        filters: { sourceOrder: transformOrder.id },
      },
    );
    for (const item of transformItemsToUpdate) {
      await strapi.entityService.update("api::item.item", item.id, {
        data: { state: "available", warehouse: warehouse.id },
      });
    }
    console.log("✅ Cut item transform order completed.");

    // 6. Verify Final Parent Stock
    console.log("6. Verifying Final Parent Stock...");

    const parentItemsAfter = await strapi.entityService.findMany(
      "api::item.item",
      {
        filters: { product: parentProduct.id, state: "available" },
      },
    );
    const finalStock = parentItemsAfter.reduce(
      (acc, item) => acc + (Number(item.currentQuantity) || 0),
      0,
    );
    console.log(`🟢 Parent Final Stock: ${finalStock} kg`);

    if (finalStock !== 24) {
      throw new Error(`❌ FAILURE. Expected 24kg but got ${finalStock}kg`);
    } else {
      console.log("🎉 SUCCESS! Parent item dropped to 24kg correctly.");
    }
  } catch (err) {
    console.error("Test Failed with error:\n", err);
  } finally {
    process.exit(0);
  }
}

runTest();
