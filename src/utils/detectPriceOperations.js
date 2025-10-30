"use strict";

/**
 * Detecta qué operaciones se deben realizar sobre los registros de precios (prices)
 * al actualizar un customer, comparando los prices actuales con los nuevos.
 *
 * Esta función identifica:
 * - Prices que deben crearse (vienen sin id)
 * - Prices que deben actualizarse (tienen id y están en el array nuevo)
 * - Prices que deben eliminarse (están en la BD pero no en el array nuevo)
 *
 * @param {Array<Object>} currentPrices - Array de prices actuales desde la base de datos.
 *   Cada elemento debe tener al menos un campo 'id'.
 *   Ejemplo: [
 *     { id: '65bc51b0-0975-478b-a414-7662086e2956', product: 1, unitPrice: 15000, ivaIncluded: true },
 *     { id: 'abc123...', product: 2, unitPrice: 20000, ivaIncluded: false }
 *   ]
 *
 * @param {Array<Object>} incomingPrices - Array de prices nuevos que se desean establecer.
 *   - Si un elemento tiene 'id', se considera una actualización
 *   - Si un elemento NO tiene 'id', se considera una creación
 *   Ejemplo: [
 *     { id: '65bc51b0-0975-478b-a414-7662086e2956', product: 1, unitPrice: 18000, ivaIncluded: true },
 *     { product: 3, unitPrice: 25000, ivaIncluded: false }  // sin id = crear
 *   ]
 *
 * @returns {Object} Objeto con tres arrays:
 *   - toCreate: Array de objetos price que deben crearse (no tienen id)
 *   - toUpdate: Array de objetos price que deben actualizarse (tienen id válido)
 *   - toDelete: Array de objetos price actuales que deben eliminarse (no están en incoming)
 *
 * @example
 * const current = [
 *   { id: 'id1', product: 1, unitPrice: 15000, ivaIncluded: true },
 *   { id: 'id2', product: 2, unitPrice: 20000, ivaIncluded: false }
 * ];
 * const incoming = [
 *   { id: 'id1', product: 1, unitPrice: 18000, ivaIncluded: true },  // actualizar
 *   { product: 3, unitPrice: 25000, ivaIncluded: false }             // crear
 * ];
 * const result = detectPriceOperations(current, incoming);
 * // result = {
 * //   toCreate: [{ product: 3, unitPrice: 25000, ivaIncluded: false }],
 * //   toUpdate: [{ id: 'id1', product: 1, unitPrice: 18000, ivaIncluded: true }],
 * //   toDelete: [{ id: 'id2', product: 2, unitPrice: 20000, ivaIncluded: false }]
 * // }
 *
 * @example
 * // Uso en customer service update
 * const currentCustomer = await strapi.entityService.findOne(
 *   'api::customer.customer',
 *   id,
 *   { populate: ['prices'] }
 * );
 * const { toCreate, toUpdate, toDelete } = detectPriceOperations(
 *   currentCustomer.prices || [],
 *   data.prices || []
 * );
 *
 * // Luego ejecutar las operaciones correspondientes
 * for (const price of toDelete) {
 *   await strapi.entityService.delete('api::price.price', price.id);
 * }
 * for (const price of toUpdate) {
 *   await strapi.entityService.update('api::price.price', price.id, { data: price });
 * }
 * for (const price of toCreate) {
 *   await strapi.entityService.create('api::price.price', { data: { ...price, customer: customerId } });
 * }
 */
function detectPriceOperations(currentPrices = [], incomingPrices = []) {
  // Validación de entrada
  if (!Array.isArray(currentPrices)) {
    throw new TypeError("currentPrices debe ser un array");
  }

  if (!Array.isArray(incomingPrices)) {
    throw new TypeError("incomingPrices debe ser un array");
  }

  // Crear un Set con los IDs de los prices entrantes para búsqueda eficiente
  const incomingIds = new Set(
    incomingPrices.filter((price) => price && price.id).map((price) => price.id)
  );

  // Prices a crear: aquellos que no tienen id
  const toCreate = incomingPrices.filter((price) => !price || !price.id);

  // Prices a actualizar: aquellos que tienen id y están en el array incoming
  const toUpdate = incomingPrices.filter(
    (price) => price && price.id && incomingIds.has(price.id)
  );

  // Prices a eliminar: aquellos que están en currentPrices pero no en incomingIds
  const toDelete = currentPrices.filter(
    (price) => price && price.id && !incomingIds.has(price.id)
  );

  return {
    toCreate,
    toUpdate,
    toDelete,
  };
}

module.exports = detectPriceOperations;
