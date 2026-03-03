"use strict";

const { PRODUCT_SERVICE } = require("../../../../utils/services");

/**
 * Lifecycle callbacks para el content-type Product
 * Sincroniza automáticamente con Siigo en cada operación CRUD
 */

function sanitizeProductCode(code) {
  if (!code) return code;
  return String(code)
    .toUpperCase()
    .trim()
    .replace(/[\s]+/g, "-")
    .replace(/[^\w-]/g, "");
}

/**
 * Helper function to auto-create or update a child 'cutItem' product and transformation factor.
 */
async function syncCutProduct(productData, productId) {
  try {
    if (!productData) return;

    const {
      canCut,
      cutUnit,
      cutTransformationFactor,
      unit,
      name,
      isActive,
      category,
      collections,
    } = productData;

    // We only process if canCut is toggled on and the required fields are present.
    // If canCut is false, let's try to find an existing child cutItem and deactivate it.
    if (!canCut) {
      try {
        const existingCuts = await strapi.entityService.findMany(
          "api::product.product",
          {
            filters: { parentProduct: productId, type: "cutItem" },
          },
        );
        if (existingCuts && existingCuts.length > 0) {
          for (const cut of existingCuts) {
            if (cut.isActive) {
              await strapi.entityService.update(
                "api::product.product",
                cut.id,
                {
                  data: { isActive: false },
                },
              );
              console.log(
                `[Product Lifecycle] Auto-deactivated child cutItem product ${cut.id} because parent canCut is now false.`,
              );
            }
          }
        }
      } catch (e) {
        console.error(
          "[Product Lifecycle] Error deactivating child cutItem:",
          e.message,
        );
      }
      return;
    }

    if (!cutUnit || !unit || !cutTransformationFactor || !name) {
      console.warn(
        `[Product ${productId}] canCut is true but missing cutUnit, unit, name, or cutTransformationFactor. Skipping sync.`,
      );
      return;
    }

    // 1. Find or create the transformation factor
    let factorId = null;
    const existingFactors = await strapi.entityService.findMany(
      "api::transformation-factor.transformation-factor",
      {
        filters: {
          sourceUnit: cutUnit,
          destinationUnit: unit,
          factor: cutTransformationFactor,
        },
      },
    );

    if (existingFactors && existingFactors.length > 0) {
      factorId = existingFactors[0].id;
    } else {
      const factorName = `De ${cutUnit} a ${unit} (x${cutTransformationFactor})`;
      const newFactor = await strapi.entityService.create(
        "api::transformation-factor.transformation-factor",
        {
          data: {
            name: factorName,
            sourceUnit: cutUnit,
            destinationUnit: unit,
            factor: cutTransformationFactor,
          },
        },
      );
      factorId = newFactor.id;
      console.log(
        `[Product Lifecycle] Created new transformation-factor ${factorId} for product ${productId}`,
      );
    }

    // 2. Find or create the child cutItem product
    const existingCuts = await strapi.entityService.findMany(
      "api::product.product",
      {
        filters: { parentProduct: { id: productId }, type: "cutItem" },
        populate: ["transformationFactor"],
      },
    );

    const expectedChildName = `${name} - ${cutUnit}`;
    const childProductData = {
      name: expectedChildName,
      unit: cutUnit,
      type: "cutItem",
      parentProduct: productId,
      transformationFactor: factorId,
      isActive: isActive !== undefined ? isActive : true,
      category: category,
      collections: collections,
    };

    if (existingCuts && existingCuts.length > 0) {
      // Update existing child
      const childCut = existingCuts[0];
      const needsUpdate =
        childCut.name !== expectedChildName ||
        childCut.unit !== cutUnit ||
        childCut.transformationFactor?.id !== factorId;

      if (
        needsUpdate ||
        (isActive !== undefined && childCut.isActive !== isActive)
      ) {
        await strapi.entityService.update("api::product.product", childCut.id, {
          data: childProductData,
        });
        console.log(
          `[Product Lifecycle] Updated child cutItem product ${childCut.id} for parent ${productId}`,
        );
      }
    } else {
      // Create new child
      // Before create, let's fetch the full parent for generating code if needed
      // But Since child product goes through beforeCreate, it will generate its own code!
      const newCutProduct = await strapi.entityService.create(
        "api::product.product",
        {
          data: childProductData,
        },
      );
      console.log(
        `[Product Lifecycle] Created new child cutItem product ${newCutProduct.id} for parent ${productId}`,
      );
    }
  } catch (err) {
    console.error(
      `[Product Lifecycle] Error syncing cut product for ${productId}:`,
      err.message,
    );
  }
}

module.exports = {
  /**
   * Hook que se ejecuta antes de crear un product
   */
  async beforeCreate(event) {
    try {
      const { params } = event;
      const { data } = params;

      // Logic for automatic code generation if not provided
      if (!data.code && data.name) {
        // Build base name parsing: "Piel de Durazno - 175 / Blanco"
        // Try to split by common separators. If none, treat the whole string as categoryName.
        const parts = data.name.split(/\s-\s|\s\/\s/);
        const categoryName = parts[0] ? parts[0].trim() : data.name.trim();
        const modelNumber = parts.length > 1 ? parts[1].trim() : "000";

        // Build ACRONYM
        const words = categoryName
          .split(/\s+/)
          .filter(
            (w) =>
              !["DE", "DEL", "LA", "EL", "LOS", "LAS", "Y"].includes(
                w.toUpperCase(),
              ),
          );
        let acronym = "";
        if (words.length === 1) {
          acronym = words[0].substring(0, 2).toUpperCase();
        } else if (words.length > 0) {
          words.forEach((w) => {
            acronym += w.charAt(0).toUpperCase();
          });
        } else {
          acronym = "XX";
        }

        const baseCode = `${acronym}-${modelNumber}`;

        // Append the -01, -02 suffix
        let currentIndex = 1;
        let proposedCode = `${baseCode}-${String(currentIndex).padStart(2, "0")}`;

        while (true) {
          const existing = await strapi.entityService.findMany(
            "api::product.product",
            {
              filters: { code: proposedCode },
              fields: ["id"],
              limit: 1,
            },
          );

          if (existing.length === 0) {
            break;
          }
          currentIndex++;
          proposedCode = `${baseCode}-${String(currentIndex).padStart(2, "0")}`;
        }

        data.code = sanitizeProductCode(proposedCode);
      } else if (data.code) {
        data.code = sanitizeProductCode(data.code);
      }

      // Logic for automatic sequential barcode generation if not provided
      if (!data.barcode) {
        // We need to fetch the highest existing numeric barcode
        // Since barcode is a string UID, searching by highest string can be tricky if they differ in lengths,
        // but if they are 0001, 0002... a descending string sort works perfectly.
        const lastProducts = await strapi.entityService.findMany(
          "api::product.product",
          {
            filters: { barcode: { $notNull: true } },
            fields: ["barcode"],
            sort: { barcode: "desc" },
            limit: 10, // search top 10 to find first purely numeric
          },
        );

        let nextBarcodeNum = 1;

        if (lastProducts && lastProducts.length > 0) {
          for (const p of lastProducts) {
            if (/^\d+$/.test(p.barcode)) {
              nextBarcodeNum = parseInt(p.barcode, 10) + 1;
              break;
            }
          }
        }

        // Pad and check
        let proposedBarcode = String(nextBarcodeNum).padStart(4, "0");
        while (true) {
          const existing = await strapi.entityService.findMany(
            "api::product.product",
            {
              filters: { barcode: proposedBarcode },
              fields: ["id"],
              limit: 1,
            },
          );

          if (existing.length === 0) {
            break;
          }
          nextBarcodeNum++;
          proposedBarcode = String(nextBarcodeNum).padStart(4, "0");
        }

        data.barcode = proposedBarcode;
      }
    } catch (error) {
      console.error(
        "[Product Lifecycle] Error en beforeCreate:",
        error.message,
      );
    }
  },

  /**
   * Hook que se ejecuta antes de actualizar un product
   */
  async beforeUpdate(event) {
    try {
      const { params } = event;
      if (params && params.data && params.data.code) {
        params.data.code = sanitizeProductCode(params.data.code);
      }
    } catch (error) {
      console.error(
        "[Product Lifecycle] Error en beforeUpdate:",
        error.message,
      );
    }
  },

  /**
   * Hook que se ejecuta después de crear un product
   */
  async afterCreate(event) {
    try {
      const { result, params } = event;

      // --- Logic: Automatic Collection Assignment ---
      const hasCollections =
        params.data.collections &&
        Array.isArray(params.data.collections) &&
        params.data.collections.length > 0;

      if (!hasCollections && result.name) {
        // Extract category name: "Piel de Durazno - 175" -> "Piel de Durazno"
        // Split by " - " or " / "
        const parts = result.name.split(/\s-\s|\s\/\s/);
        const categoryName = parts[0] ? parts[0].trim() : null;

        if (categoryName) {
          try {
            // Find existing collection
            const collections = await strapi.entityService.findMany(
              "api::collection.collection",
              {
                filters: { name: categoryName },
                limit: 1,
              },
            );

            let collectionId;

            if (collections.length > 0) {
              collectionId = collections[0].id;
            } else {
              // Create new collection
              console.log(
                `[Product Lifecycle] Creating new collection: "${categoryName}"`,
              );
              const newCollection = await strapi.entityService.create(
                "api::collection.collection",
                {
                  data: { name: categoryName },
                },
              );
              collectionId = newCollection.id;
            }

            // Update product with collection
            if (collectionId) {
              await strapi.entityService.update(
                "api::product.product",
                result.id,
                {
                  data: {
                    collections: { connect: [collectionId] },
                  },
                },
              );
              console.log(
                `[Product Lifecycle] Auto-assigned collection "${categoryName}" to product ${result.id}`,
              );
            }
          } catch (err) {
            console.error(
              "[Product Lifecycle] Error assigning collection:",
              err.message,
            );
          }
        }
      }
      // ----------------------------------------------

      // Trigger automatic cutItem sync
      await syncCutProduct(result, result.id);

      if (process.env.NODE_ENV !== "production") {
        console.log(
          `[Product Lifecycle] Omitiendo sincronización con Siigo en ambiente no productivo (${process.env.NODE_ENV}).`,
        );
        return;
      }

      const productService = strapi.service("api::siigo.product");

      // Si ya tiene siigoId, significa que ya está sincronizado con Siigo
      if (result.siigoId) {
        return;
      }

      // Intentar buscar en Siigo por código primero
      if (result.code) {
        const productFromSiigo = await productService.searchInSiigoByCode(
          result.code,
        );

        if (productFromSiigo) {
          // Si existe, actualizamos localmente el siigoId
          await strapi.db.query(PRODUCT_SERVICE).update({
            where: { id: result.id },
            data: { siigoId: String(productFromSiigo.id) },
          });
          console.log(
            `[Product Lifecycle] Product ${result.id} vinculado con Siigo ID ${productFromSiigo.id}`,
          );
          return;
        }
      } else {
        console.warn(
          `[Product ${result.id}] No tiene code, se omite búsqueda en Siigo`,
        );
        return;
      }
      // Si no existe, crear en Siigo
      await productService.createInSiigo(result.id);
    } catch (error) {
      console.error("[Product Lifecycle] Error en afterCreate:", error.message);
    }
  },

  /**
   * Hook que se ejecuta después de actualizar un product
   */
  async afterUpdate(event) {
    try {
      const { result } = event;

      // Evitar bucle si la actualización viene de syncFromSiigo
      const ctx = strapi.requestContext.get();
      if (ctx?.state?.isSyncingFromSiigo) {
        return;
      }

      // Trigger automatic cutItem sync using the full product state instead of just the 'result'
      // since result might only contain fields that changed in this edit.
      const fullProduct = await strapi.entityService.findOne(
        "api::product.product",
        result.id,
        {
          populate: ["collections"],
        },
      );

      await syncCutProduct(fullProduct, result.id);

      if (process.env.NODE_ENV !== "production") {
        console.log(
          `[Product Lifecycle] Omitiendo sincronización con Siigo en ambiente no productivo (${process.env.NODE_ENV}).`,
        );
        return;
      }

      const productService = strapi.service("api::siigo.product");

      // Si tiene siigoId, actualizamos en Siigo
      if (result.siigoId) {
        await productService.updateInSiigo(result.id);
      } else {
        // Si no tiene siigoId, intentamos crearlo
        await productService.createInSiigo(result.id);
      }
    } catch (error) {
      console.error("[Product Lifecycle] Error en afterUpdate:", error.message);
    }
  },

  /**
   * Hook que se ejecuta después de eliminar un product
   */
  async afterDelete(event) {
    try {
      const { result } = event;

      if (process.env.NODE_ENV !== "production") {
        console.log(
          `[Product Lifecycle] Omitiendo sincronización con Siigo en ambiente no productivo (${process.env.NODE_ENV}).`,
        );
        return;
      }

      const productService = strapi.service("api::siigo.product");

      // Solo sincronizar si el product tenía siigoId
      if (result.siigoId) {
        await productService.deleteInSiigo(result.id);
      }
    } catch (error) {
      console.error("[Product Lifecycle] Error en afterDelete:", error.message);
    }
  },
};
