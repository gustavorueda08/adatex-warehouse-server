"use strict";

const { validateFields } = require("../../../utils/validateRequiredFields");

/**
 * barcode-mapping service
 */

const { createCoreService } = require("@strapi/strapi").factories;

module.exports = createCoreService(
  "api::barcode-mapping.barcode-mapping",
  ({ strapi }) => ({
    async findMany(data) {
      try {
        const requireFields = ["trx"];
        validateFields(
          data,
          requireFields,
          "Faltan datos para obtener el virtualmapping:"
        );
        const { filters = {}, trx } = data;
        const codeMappings = await strapi.entityService.findMany(
          "api::barcode-mapping.barcode-mapping",
          {
            filters,
          },
          { transacting: trx }
        );
        return codeMappings;
      } catch (error) {
        throw error;
      }
    },
    async create(data) {
      try {
        const requireFields = [
          "trx",
          "itemId",
          "virtualBarcode",
          "realBarcode",
          "type",
        ];
        validateFields(data, requireFields);
        const { trx, ...codeMappingData } = data;
        const codeMapping = await strapi.entityService.create(
          "api::barcode-mapping.barcode-mapping",
          {
            data: codeMappingData,
          },
          { transacting: trx }
        );
        if (!codeMapping) throw new Error("Error al crear el virtual code");
        return codeMapping;
      } catch (error) {
        throw error;
      }
    },
    async delete(id, data) {
      try {
        const requireFields = ["trx"];
        validateFields(data, requireFields);
        const { trx } = data;
        if (!id)
          throw new Error("El id es requerido para eliminar el barcodeMapping");
        await strapi.entityService.delete(
          "api::barcode-mapping.barcode-mapping",
          id,
          { transacting: trx }
        );
      } catch (error) {
        throw error;
      }
    },
  })
);
