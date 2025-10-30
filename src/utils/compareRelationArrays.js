"use strict";

/**
 * Compara dos arrays de IDs (actuales vs nuevos) para determinar qué relaciones
 * deben agregarse, eliminarse o mantenerse en una actualización.
 *
 * Esta función es útil para sincronizar relaciones many-to-many o one-to-many
 * en operaciones de actualización, como taxes, parties, etc.
 *
 * @param {Array<number|Object>} currentIds - Array de IDs actuales.
 *   Puede ser un array de números o un array de objetos con propiedad 'id'.
 *   Ejemplo: [1, 2, 3] o [{id: 1}, {id: 2}, {id: 3}]
 *
 * @param {Array<number|Object>} newIds - Array de IDs nuevos que se desean establecer.
 *   Puede ser un array de números o un array de objetos con propiedad 'id'.
 *   Ejemplo: [2, 3, 4] o [{id: 2}, {id: 3}, {id: 4}]
 *
 * @returns {Object} Objeto con tres arrays:
 *   - toAdd: Array de IDs que deben agregarse (están en newIds pero no en currentIds)
 *   - toRemove: Array de IDs que deben eliminarse (están en currentIds pero no en newIds)
 *   - toKeep: Array de IDs que deben mantenerse (están en ambos arrays)
 *
 * @example
 * // Caso básico con números
 * const result = compareRelationArrays([1, 2, 3], [2, 3, 4]);
 * // result = { toAdd: [4], toRemove: [1], toKeep: [2, 3] }
 *
 * @example
 * // Caso con objetos
 * const currentTaxes = [{id: 1, name: "IVA"}, {id: 2, name: "Retencion"}];
 * const newTaxIds = [2, 3];
 * const result = compareRelationArrays(currentTaxes, newTaxIds);
 * // result = { toAdd: [3], toRemove: [1], toKeep: [2] }
 *
 * @example
 * // Uso en customer update para taxes
 * const customer = await strapi.entityService.findOne(
 *   'api::customer.customer',
 *   id,
 *   { populate: ['taxes'] }
 * );
 * const currentTaxIds = customer.taxes?.map(t => t.id) || [];
 * const { toAdd, toRemove, toKeep } = compareRelationArrays(currentTaxIds, data.taxes);
 *
 * // Luego usar toAdd y toRemove para actualizar las relaciones
 */
function compareRelationArrays(currentIds = [], newIds = []) {
  // Validación de entrada
  if (!Array.isArray(currentIds)) {
    throw new TypeError("currentIds debe ser un array");
  }

  if (!Array.isArray(newIds)) {
    throw new TypeError("newIds debe ser un array");
  }

  // Normalizar arrays a números simples
  const normalizedCurrent = normalizeIds(currentIds);
  const normalizedNew = normalizeIds(newIds);

  // Crear Sets para operaciones eficientes
  const currentSet = new Set(normalizedCurrent);
  const newSet = new Set(normalizedNew);

  // Calcular diferencias
  const toAdd = normalizedNew.filter((id) => !currentSet.has(id));
  const toRemove = normalizedCurrent.filter((id) => !newSet.has(id));
  const toKeep = normalizedCurrent.filter((id) => newSet.has(id));

  return {
    toAdd,
    toRemove,
    toKeep,
  };
}

/**
 * Normaliza un array de IDs que puede contener números u objetos con propiedad 'id'
 * a un array de números únicos.
 *
 * @private
 * @param {Array<number|Object>} ids - Array a normalizar
 * @returns {Array<number>} Array de números únicos
 * @throws {TypeError} Si algún elemento no es número ni objeto con id válido
 */
function normalizeIds(ids) {
  if (ids.length === 0) {
    return [];
  }

  const normalized = ids.map((item) => {
    // Si es número, retornar directamente
    if (typeof item === "number") {
      return item;
    }

    // Si es objeto con propiedad id
    if (item && typeof item === "object" && "id" in item) {
      const id = item.id;
      if (typeof id === "number") {
        return id;
      }
      throw new TypeError(
        `El objeto contiene una propiedad 'id' que no es un número: ${typeof id}`
      );
    }

    // Si llegamos aquí, el formato no es válido
    throw new TypeError(
      `Elemento inválido en el array: esperado número u objeto con 'id', recibido ${typeof item}`
    );
  });

  // Eliminar duplicados
  return [...new Set(normalized)];
}

module.exports = compareRelationArrays;
