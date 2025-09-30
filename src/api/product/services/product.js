"use strict";

const {
  validateRequiredFields,
} = require("../../../utils/validateRequiredFields");

/**
 * product service
 */

const { createCoreService } = require("@strapi/strapi").factories;

module.exports = createCoreService("api::product.product");
